// W-CMDIMPL ③（#216，设计 §3）——release.ts 编排断言：常量表硬编码（P0-2 红线）/
// config-set 拒 script 字段/前置机械闸/二次确认/单飞互斥/事件节流面/history 落盘。
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-release.ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { RELEASE_CHANNELS, mainRepoRoot, ReleaseModule } from "../src/release.js";

let pass = 0, fail = 0;
const assert = (cond: boolean, name: string) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

const saved = process.env.CCR_MAIN_REPO;
const root = mkdtempSync(join(tmpdir(), "cc-deck-rel-"));
const repo = join(root, "repo");
const dataD = join(root, "data");
mkdirSync(join(repo, "scripts"), { recursive: true });
mkdirSync(dataD, { recursive: true });
process.env.CCR_MAIN_REPO = repo;
// 假仓：VERSION + 假脚本 + git dev 干净
writeFileSync(join(repo, "VERSION"), "0.7.0-test.999\n");
writeFileSync(join(repo, "scripts", "build-test-apk.sh"), "#!/bin/bash\necho \"[1/5] 段落开始\"\necho \"manifest_gate ✓\"\necho \"https://dl.example.com/pkg.apk\"\n");
const g = (a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf-8" });
g(["init", "-q"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
writeFileSync(join(repo, "f.txt"), "1"); g(["add", "-A"]); g(["commit", "-qm", "init"]);
g(["checkout", "-qb", "dev"]);

// 假 EventBus（事件收集）
const events: { type: string; payload: unknown }[] = [];
const bus = { emitTransient: (type: string, payload: unknown) => { events.push({ type, payload }); } } as never;

console.log("常量表硬编码（P0-2 红线）:");
assert(Object.keys(RELEASE_CHANNELS).includes("apk-test") && Object.keys(RELEASE_CHANNELS).includes("desktop-test"), "双通道脚本映射在源码常量");
assert(RELEASE_CHANNELS["apk-test"] === "scripts/build-test-apk.sh", "映射值正确");

const rel = new ReleaseModule(bus as never, dataD);
console.log("config 面:");
const cfg0 = rel.configGet();
assert(cfg0.ok === true && cfg0.data.version === "0.7.0-test.999", "config-get 带版本");
assert(Array.isArray(cfg0.data.channels) && (cfg0.data.channels as unknown[]).length === 2, "双通道开关面");
const cs = rel.configSet({ channels: [{ id: "apk-test", enabled: true }], script: "/evil.sh" } as never);
assert(cs.ok === true, "config-set 成功");
const rawCfg = readFileSync(join(dataD, "release-config.json"), "utf-8");
assert(!rawCfg.includes("evil") && !rawCfg.includes("script"), "script 字段不落盘（P0-2 红线）");
assert(rawCfg.includes('"apk-test"'), "开关落盘");

console.log("前置机械闸（P2-2）:");
// 脏仓拒跑（先造脏——dev 分支在场但 porcelain 不干净）
writeFileSync(join(repo, "dirty.txt"), "x");
const dirty = rel.run({ channel: "apk-test", confirm: true });
assert(dirty.ok === false && !!(dirty as { error?: string }).error?.includes("未提交"), "主仓脏 → 拒跑");
// 分支错拒跑
g(["checkout", "-qb", "feat-wrong"]);
const wrongBranch = rel.run({ channel: "apk-test", confirm: true });
assert(wrongBranch.ok === false && !!(wrongBranch as { error?: string }).error?.includes("分支"), "非 dev 分支 → 拒跑");
g(["checkout", "dev"]);
g(["add", "-A"]); g(["commit", "-qm", "clean again"]);
// dev 干净 → 可启动（等首轮跑完防单飞窗口串扰）
const cleanRun = rel.run({ channel: "apk-test", note: "走查批", confirm: true });
assert(cleanRun.ok === true && typeof (cleanRun.data as { run_id?: string }).run_id === "string", "dev 干净 → run 启动");
await new Promise((res) => setTimeout(res, 800));

console.log("二次确认（拍板 #8）:");
const noConfirm = rel.run({ channel: "apk-test" });
assert(noConfirm.ok === false && !!(noConfirm as { error?: string }).error?.includes("二次确认"), "无 confirm:true 拒");

console.log("run 编排+事件+history:");
const hist = rel.listHistory(5);
assert(hist[0]?.status === "done", `脚本跑完 status=done（实得 ${hist[0]?.status}）`);
assert(!!hist[0]?.urls?.some((u) => u.includes("example.com")), "直链从 stdout 提取");
const prog = rel.configGet().data.progress as Record<string, string>;
assert(typeof prog["apk-test"] === "string", "progress 快照面在（轮询消费）");
const segEvents = events.filter((e) => e.type === "RELEASE_PROGRESS");
const doneEvents = events.filter((e) => e.type === "RELEASE_DONE");
assert(segEvents.length >= 2, `段落级 PROGRESS 事件 ${segEvents.length} 条（节流面）`);
assert(doneEvents.length === 1, "RELEASE_DONE 终态事件");
assert(existsSync(hist[0]!.log_file!), "全量 stdout 落日志文件");

console.log("单飞互斥:");
writeFileSync(join(repo, "scripts", "build-test-apk.sh"), "#!/bin/bash\nsleep 5\n");
g(["add", "-A"]); g(["commit", "-qm", "slow script"]); // 脚本覆盖后收口——precheck porcelain 闸不误拦
const r1 = rel.run({ channel: "apk-test", confirm: true });
assert(r1.ok === true, "第一跑启动");
const r2 = rel.run({ channel: "apk-test", confirm: true });
assert(r2.ok === false && !!(r2 as { error?: string }).error?.includes("单飞互斥"), "同通道并发拒（409 语义）");
// 未知通道
const r3 = rel.run({ channel: "nope", confirm: true });
assert(r3.ok === false && !!(r3 as { error?: string }).error?.includes("未知通道"), "未知通道拒");

console.log("部署边界:");
process.env.CCR_MAIN_REPO = join(root, "no-such-repo");
const rel2 = new ReleaseModule(bus as never, dataD);
const ne = rel2.run({ channel: "apk-test", confirm: true });
assert(ne.ok === false && (ne as { error?: string }).error === "no_release_env", "无发版环境 → no_release_env 错误码");
assert(rel2.hasReleaseEnv() === false, "hasReleaseEnv=false（UI 置灰依据）");
process.env.CCR_MAIN_REPO = saved;

rmSync(root, { recursive: true, force: true });
console.log(`\n== release: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
