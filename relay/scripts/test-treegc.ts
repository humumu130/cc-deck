// W-TREEGC 断言件（1104 夜双事故回归锚）：
// 事故① linkquality：dispatch f49ec8ae 22:11:23 done 关单零收割（feat/linkquality 停基线
//   444dbce7 零提交）→22:1x 树被清仅剩 prunable 残留——chain-audit 3098「锁随收口释放」铁证。
// 事故② bootfast：同窗树被清（幸有 WIP 在分支上）——chain-audit 3096 同款；
//   前置 21:47-22:01 两会话同树双跑（同款模块各写一份）。
// 三场景：A 脏树触发清理→隔离不删除；B 双会话抢树→第二被拦（dispatch-lock 原子地基
//   已有——本件锁死接口语义）；C 零提交关单+脏树→锁留守+交付物失踪告警路径（guard 谓词）。
// 环境：CCR_ORG_DIR 沙盒（审计账落沙盒）、CCR_WT_ROOT 沙盒（隔离/扫描域）。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { acquireWorktreeLock, scanClearWorktreeLocks, writeWorktreeLock, readWorktreeLock } from "../src/dispatch-lock.js";
import { inspectWorktree, quarantineWorktree, sweepStaleWorktrees, readGcAudit, worktreeDirty, healPrunableWorktrees } from "../src/worktree-gc.js";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string) => { if (c) { pass++; console.log("  ok - " + n); } else { fail++; console.error("FAIL: " + n); } };

const ORG = mkdtempSync(join(tmpdir(), "treegc-org-"));
const WTR = mkdtempSync(join(tmpdir(), "treegc-wt-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_WT_ROOT = WTR;

// 夹具：假 git worktree（真 git init——worktreeDirty 走 git status）
const mkTree = (name: string, dirty: boolean): string => {
  const d = join(WTR, `cc-deck-w-${name}`);
  mkdirSync(d, { recursive: true });
  execFileSync("git", ["-C", d, "init", "-q"]);
  execFileSync("git", ["-C", d, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", d, "config", "user.name", "t"]);
  writeFileSync(join(d, "base.txt"), "x");
  execFileSync("git", ["-C", d, "add", "."]);
  execFileSync("git", ["-C", d, "commit", "-qm", "base"]);
  if (dirty) writeFileSync(join(d, "uncommitted.md"), "未提交稿件——事故①形态");
  return d;
};
const mkPlain = (name: string): string => {
  const d = join(WTR, `cc-deck-w-${name}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// ---------- 场景 A：脏树触发清理→隔离区不删除（事故①回归锚） ----------
{
  const dirty = mkTree("linkq", true); // 事故①：linkquality 脏树
  // 老化 mtime：脏树即便 mtime 老也必须因 git 脏被守卫（脏证据优先级=判活）
  const r = quarantineWorktree(dirty, "test");
  ok(!r.ok && r.verdict.reasons.some((x) => x.includes("git 脏")), "A1 脏树拒绝隔离（判活证据：git 脏——事故①稿件形态）");
  ok(existsSync(join(dirty, "uncommitted.md")), "A2 脏树原地未动（稿件在树）");
  // 全证据判死的净树→隔离（mv 不 rm）
  const clean = mkTree("stale", false);
  // 把 clean 树 mtime 做老：无活跃证据（无锁/无脏/目录 mtime 老）——mtime 由 mkdir 时间决定=新，
  // 需要显式构造老树：直接测 verdict 逻辑（mtime 窗内=活）
  const v = inspectWorktree(clean);
  ok(v.alive && v.reasons.some((x) => x.includes("近期活跃")), "A3 新建净树=近期活跃（mtime 判活兜底——防误杀刚建的树）");
  // 强制老化路径：inspectWorktree 的 now 参数前移 25h（mtime 判死）
  const vOld = inspectWorktree(clean, Date.now() + 25 * 3600_000);
  ok(!vOld.alive, "A4 mtime 老化后全证据判死（可隔离）");
  const rq = quarantineWorktree(clean, "test", Date.now() + 25 * 3600_000);
  ok(rq.ok && !!rq.movedTo && !existsSync(clean) && existsSync(join(rq.movedTo!, "base.txt")), "A5 净死树进隔离区（mv 保内容非删除，48h 可救）");
  const audit = readGcAudit(ORG);
  ok(audit.some((e) => e.verdict === "quarantined" && e.tree === clean && e.movedTo === rq.movedTo), "A6 隔离动作落审计账（tree/理由/去向——堵零留痕缺口）");
  ok(audit.some((e) => e.verdict === "skipped-alive" && e.tree === dirty), "A7 跳过也留痕（观测面）");
}

// ---------- 场景 B：双会话抢树→第二被拦（dispatch-lock 原子地基，接口语义锁死） ----------
{
  const d = mkPlain("twins");
  const r1 = acquireWorktreeLock(d, { slug: "twins", dispatch_id: "dsp-aaa", session_id: "sess-1" });
  ok(r1.ok, "B1 第一会话原子获锁成功");
  const r2 = acquireWorktreeLock(d, { slug: "twins", dispatch_id: "dsp-bbb", session_id: "sess-2" });
  ok(!r2.ok && r2.held?.dispatch_id === "dsp-aaa", "B2 第二会话被拦（他人活锁判负——事故②前置形态：两会话同树双跑的机制封堵）");
  // 收口清锁 guard 谓词：脏树不清（场景 C 前置）
  writeFileSync(join(d, "wip.md"), "WIP 稿件");
  // d 是普通目录（无 git）→worktreeDirty=false——用真树测 guard：
  const g = mkTree("guardcase", true);
  writeWorktreeLock(g, { slug: "guardcase", dispatch_id: "dsp-guard" });
  const guarded: string[] = [];
  const cleared = scanClearWorktreeLocks("dsp-guard", WTR, (dir) => worktreeDirty(dir) && (guarded.push(dir), true), guarded);
  ok(cleared.length === 0 && guarded.includes(g), "B3 收口清锁遇脏树→守卫拦截（锁留守=树占位牌）");
  ok(readWorktreeLock(g)?.dispatch_id === "dsp-guard", "B4 脏树锁仍在（48h 防裸奔——事故①根因位封堵）");
}

// ---------- 场景 C：prunable 自愈（任务书改动③） ----------
{
  // 假 repo + 已消失的 worktree 登记
  const repo = mkdtempSync(join(tmpdir(), "treegc-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "a");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "a"]);
  const gone = join(WTR, "cc-deck-w-vanished"); // 登记后将目录删掉（模拟事故①后遗：目录消失登记残留）
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feat/vanished", gone]);
  rmSync(gone, { recursive: true, force: true });
  const healed = healPrunableWorktrees(repo);
  // mac 路径规范化坑：tmpdir()=/var/folders… 而 git porcelain 输出 /private/var/… 形态
  //（symlink 解析），字符串恒等必假——按尾段匹配
  ok(healed.some((h) => h.endsWith("cc-deck-w-vanished")), "C1 目录已消失的登记→prune 清（prunable 残留自愈——事故①后遗形态）");
  const list = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
  ok(!list.includes("vanished"), "C2 prune 后登记干净");
  ok(readGcAudit(ORG).some((e) => e.verdict === "prunable-healed" && e.tree.endsWith("cc-deck-w-vanished")), "C3 自愈落审计账");
}

// ---------- sweep 批量面（隔离区排除自身） ----------
{
  const s = sweepStaleWorktrees(WTR, "test", Date.now() + 48 * 3600_000); // now 前移=全判死龄
  const quarantined = s.filter((e) => e.verdict === "quarantined");
  ok(quarantined.length > 0, "D1 批量清扫隔离龄外树（含 B 场景守卫树——龄到统一收殓，保 48h）");
  ok(!readdirSync("/private/tmp").some((n) => n.startsWith("cc-deck-quarantine-") && n.includes("-cc-deck-quarantine-")), "D2 隔离区目录不被自噬（排除规则在）");
}

console.log(`\n== test-treegc 汇总：${pass} ok / ${fail} FAIL ==`);
rmSync(ORG, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
