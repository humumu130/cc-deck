// W-AGGREGATE-V2（PCS 多 clone 场景续）断言档：
//   A 探测器：normalizeRemoteUrl 归一矩阵+真 git clone 夹具（同 origin 两目录探测归一）+
//     TTL 缓存（二次命中零子进程）+非 git 目录无信号不炸
//   B anchors[]：anchor_dirs 建组持久化（主锚首位）/findGroupByAnchor any-of 命中附锚/
//     冲突检查双向 any-of/存量单锚组零迁移读兼容
//   C 归因域：experience anchorExists 多锚 some
//   D 端上静态锚：dirOrigins 快照消费/簇归一函数+三证据行/簇指纹忽略/建团簇预填 dirs+
//     payload anchor_dirs/多锚 some 分桶/external 纳管（V1 已落锚锁定）
// 环境隔离：mkdtemp ORG/DATA + 真 git 子进程（init+remote add——tech-B 探测面的真实夹具）。
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

process.env.CCR_STORAGE_READ_MODE = "json";
const ORG = mkdtempSync(join(tmpdir(), "agg2-org-"));
const DATA = mkdtempSync(join(tmpdir(), "agg2-data-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_DATA_DIR = DATA;
delete process.env.CCR_CWD;

const repoRoot = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", "..");
let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

async function main() {
  const { normalizeRemoteUrl, normDirKey, probeDirOrigin, initDirOriginStore, dirOriginsMap, enqueueDirOriginProbe, drainDirOriginProbes, __testReset } = await import("../src/dir-origin.js");
  const { createGroup, findGroupByAnchor, listGroups } = await import("../src/projects.js");
  const bcSrc = readFileSync(join(repoRoot, "web-console/js/bridge-core.js"), "utf-8");
  const tdSrc = readFileSync(join(repoRoot, "web-console/js/team-domain.js"), "utf-8");
  const smSrc = readFileSync(join(repoRoot, "relay/src/session-manager.ts"), "utf-8");
  const patrolSrc = readFileSync(join(repoRoot, "relay/src/patrol.ts"), "utf-8");
  const schemaSrc = readFileSync(join(repoRoot, "relay/src/org-schema.ts"), "utf-8");

  // ================= A 探测器 =================
  console.log("A 探测器：");
  ok(normalizeRemoteUrl("https://GitHub.com/acme/pcs.git") === "github.com/acme/pcs", "A1 https 归一（协议/.git 去+host 小写）");
  ok(normalizeRemoteUrl("git@github.com:acme/pcs.git") === "github.com/acme/pcs", "A2 ssh scp 归一（与 https 同源可归一）");
  ok(normalizeRemoteUrl("https://github.com/acme/pcs/") === "github.com/acme/pcs", "A3 尾斜杠归一");
  ok(normDirKey("/a/b\\c\\") === "/a/b/c", "A4 normDirKey 反斜杠+尾斜杠归一（端上桶键同口径）");

  initDirOriginStore(DATA);
  __testReset();
  // 真 git 夹具：裸仓 + 两 clone（同 origin——PCS 多 clone 形态）
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  const bare = join(DATA, "pcs.git");
  mkdirSync(bare, { recursive: true }); git(bare, "init", "--bare", "-b", "main");
  const c1 = join(DATA, "clone-a"), c2 = join(DATA, "clone-b"), plain = join(DATA, "plain-docs");
  for (const c of [c1, c2, plain]) mkdirSync(c, { recursive: true });
  git(c1, "init", "-b", "main"); git(c1, "remote", "add", "origin", bare);
  git(c2, "init", "-b", "main"); git(c2, "remote", "add", "origin", "https://github.com/acme/pcs.git");
  const o1 = await probeDirOrigin(c1), o2 = await probeDirOrigin(c2);
  ok(!!o1 && o1 === normalizeRemoteUrl(bare) && o1 === normDirKey(bare).replace(/\.git$/, ""), `A5 clone-a 探测=origin file 路径归一（${o1}——.git 尾归一剥离=pcs.git≡pcs）`);
  ok(o2 === "github.com/acme/pcs", `A6 clone-b 探测=https 归一（${o2}）`);
  const plainO = await probeDirOrigin(plain);
  ok(plainO === null, "A7 非 git 目录=无信号 null（不告警不炸——常态）");
  const before = dirOriginsMap();
  const again = await probeDirOrigin(c1);
  ok(again === o1 && Object.keys(dirOriginsMap()).length === Object.keys(before).length, "A8 TTL 缓存命中（同结果零新子进程——map 规模不变）");
  enqueueDirOriginProbe(join(DATA, "clone-c")); // 未 mkdir 的未知目录——排水探测（非 git → null 落缓存）
  const drained = await drainDirOriginProbes();
  ok(drained >= 1, "A9 入队→排水执行（入编边沿零子进程，扫描拍排水）");

  // ================= B anchors[] =================
  console.log("B anchors[]：");
  mkdirSync(join(ORG, "main-clone"), { recursive: true });
  mkdirSync(join(ORG, "work-clone"), { recursive: true });
  const r1 = createGroup({ name: "PCS 工单", anchor_dir: join(ORG, "main-clone"), tier: "轻立项", anchor_dirs: [join(ORG, "work-clone"), join(ORG, "main-clone")] }, ORG);
  const g1 = r1.ok && r1.group ? r1.group : null;
  ok(!!g1, "B1 anchor_dirs 建组 ok");
  ok(Array.isArray(g1?.anchor_dirs) && g1!.anchor_dirs![0] === join(ORG, "main-clone") && g1!.anchor_dirs!.length === 2, "B2 持久化主锚恒首位+去重");
  ok(findGroupByAnchor(join(ORG, "work-clone"), ORG)?.id === g1?.id, "B3 findGroupByAnchor any-of（附锚命中）");
  ok(findGroupByAnchor(join(ORG, "main-clone"), ORG)?.id === g1?.id, "B4 主锚命中（兼容原口径）");
  const clash = createGroup({ name: "撞锚组", anchor_dir: join(DATA, "other"), tier: "轻立项", anchor_dirs: [join(ORG, "work-clone")] }, ORG);
  ok(!clash.ok, "B5 冲突检查 any-of（新组附锚=既有组附锚 → 拒）");
  const r2 = createGroup({ name: "单锚老组", anchor_dir: join(ORG, "legacy"), tier: "轻立项" }, ORG);
  mkdirSync(join(ORG, "legacy"), { recursive: true });
  ok(r2.ok === true, "B6 单锚建团零变化（旧形态可写）");
  const legacy = listGroups(ORG).find((g) => g.name === "单锚老组");
  ok(!!legacy && !Array.isArray(legacy.anchor_dirs), "B7 存量单锚组无 anchor_dirs 键（零迁移形状）");
  ok(findGroupByAnchor(join(ORG, "legacy"), ORG)?.id === legacy?.id, "B8 存量单锚组读兼容");
  ok(schemaSrc.includes('anchor_dirs: { type: "string-array" }'), "B9 org-schema anchor_dirs 校验位（写闸）");

  // ================= C 归因域 =================
  console.log("C 归因域：");
  const expSrc = readFileSync(join(repoRoot, "relay/src/experience.ts"), "utf-8");
  ok(expSrc.includes("g.anchor_dirs) && g.anchor_dirs.some"), "C1 experience anchorExists 多锚 some 匹配");
  ok(readFileSync(join(repoRoot, "relay/src/projects.ts"), "utf-8").includes("export function anchorsOf"), "C2 anchorsOf 单点归一（单锚组零迁移兜底）");

  // ================= D 端上静态锚 =================
  console.log("D 端上静态锚：");
  ok(bcSrc.includes('dirOrigins = (p.dir_origins && typeof p.dir_origins === "object")'), "D1 快照消费 dir_origins（旧 relay 缺键=空对象零影响）");
  ok(bcSrc.includes("function aggregateClusters(") && bcSrc.includes("function aggregateClusterHint("), "D2 簇归一函数在（同源 ≥2 目录跨目录聚簇）");
  ok(bcSrc.includes('aggClusterEvidenceLine = (h) => "同目录 ×" + h.hostN + " · 同 origin ×" + h.n'), "D3 证据行三证据（同目录×N+同 origin×M+共享词）");
  ok(bcSrc.includes('aggHint.cluster ? "o:" + aggHint.origin : aggHint.dir'), "D4 簇忽略指纹=o:origin（与目录指纹不串扰——冷却/静默语义沿用）");
  ok(bcSrc.includes("entries.length < 2") && bcSrc.includes("AGG_MIN_SESSIONS"), "D5 闸沿用（≥2 目录+≥3 会话才成簇——V1 阈值复用）");
  ok(bcSrc.includes("anchorsOfGroup(group).some((a) => underAnchor(s.cwd, a))"), "D6 多锚 some 分桶（单锚组 V1 行为不变）");
  ok(tdSrc.includes("data-team-anchor-dirs") && tdSrc.includes("anchor_dirs: extraDirs"), "D7 建团簇预填附锚注+payload anchor_dirs");
  ok(smSrc.includes("enqueueDirOriginProbe(cwd)") && smSrc.includes("dirOriginsList()"), "D8 入编边沿入队+快照口（顺带补队在册 cwd）");
  ok(patrolSrc.includes("drainDirOriginProbes()"), "D9 patrol 全巡拍排水挂点");
  ok(smSrc.includes("initDirOriginStore(this.cfg.dataDir)"), "D10 构造装载缓存（dir-origins.json）");
  ok(tdSrc.includes("team-cand-ext") && tdSrc.includes("野生·观察"), "D11 external 纳管候选面在（V1 已落——本批锚锁定：可勾+观察位语义）");

  console.log(`\n== test-aggregatev2：${pass} passed / ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
}

void main();
