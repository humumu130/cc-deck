// #183 产物-会话关联持久化（artifacts-index.json）：relay 重启后 events.ndjson 压缩
// （30 会话×50 状态帧）+ replay 不回放 SESSION_UPDATED.artifacts 字段 → 面板产物
// 全靠这本账挂回。五面：
// ① deliver 登记 → keyed 账本落盘（{sid:[{path,name,size,delivered_at}]}）；
// ② 产物目录收录（mergeArtifact）同入账本；
// ③ 重启模拟：新 SessionManager（同 dataDir）+ ensureExternal → 关联从索引挂回
//   （不依赖 events.ndjson——本测试全程无事件回放）；
// ④ 旧扁平账 deliverables.json 首启迁移（含 unverified 传递）；空索引文件在即权威
//   （摘空的账不回灌旧数据）；
// ⑤ 删除同步：产物文件删除（re-stat 翻 exists=false）→ 账本同步摘除；内存 state
//   保留 dead 条目（#224 语义不回归）。
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

const root = join(process.cwd(), ".tmp-test-artifacts-persist");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "artifacts"), { recursive: true });
mkdirSync(join(root, "data"), { recursive: true });
mkdirSync(join(root, "proj"), { recursive: true });
process.env.CCR_ARTIFACTS_DIR = join(root, "artifacts");
process.env.CCR_DATA_DIR = join(root, "data");
process.env.CCR_NO_TITLE_GEN = "1";

const IDX = join(root, "data", "artifacts-index.json");
const readIndex = (): Record<string, { path: string; name?: string; size?: number; delivered_at?: number; unverified?: boolean }[]> => {
  try {
    return JSON.parse(readFileSync(IDX, "utf-8")) as Record<string, { path: string }[]>;
  } catch {
    return {};
  }
};

const bus = new EventBus();
const cfg = loadConfig();
const mgr = new SessionManager(bus, cfg);

const SID = "test-183-persist";
const st = mgr.ensureExternal(SID, join(root, "proj"), "#183 产物关联持久化测试");
assert(!!st, "session created");

// ① deliver 登记 → keyed 账本落盘
const doc = join(root, "proj", "docs", "验收报告.html");
mkdirSync(join(root, "proj", "docs"), { recursive: true });
writeFileSync(doc, "<html>report</html>");
assert(mgr.registerDeliverable(SID, doc).ok, "① deliver 登记成功");
{
  const idx = readIndex();
  const entries = idx[SID] ?? [];
  const hit = entries.find((e) => e.path === doc);
  assert(!!hit, "① 账本 keyed by 卡 id，登记条目在列");
  assert(hit?.name === basename(doc) && typeof hit?.size === "number" && hit?.size === 19, `① 条目含 name/size（got name=${hit?.name} size=${hit?.size}）`);
  assert(typeof hit?.delivered_at === "number" && hit!.delivered_at! > 0, "① 条目含 delivered_at");
}

// ② 产物目录收录（mergeArtifact）同入账本
const art1 = join(root, "artifacts", "夜间报告.html");
writeFileSync(art1, "<html>night</html>");
mgr.mergeArtifact(SID, { path: art1, tool: "Write", adds: 1, dels: 0, created: true, ts: Date.now() });
{
  const entries = readIndex()[SID] ?? [];
  assert(entries.some((e) => e.path === art1 && e.name === "夜间报告.html"), "② 产物目录条目同入账本（含 name）");
  assert(entries.filter((e) => e.path === art1).length === 1, "② sid+path 幂等不重复");
}

// ③ 重启模拟：同 dataDir 新 SessionManager（无事件回放）→ ensureExternal 挂回
{
  const mgr2 = new SessionManager(new EventBus(), cfg);
  mgr2.ensureExternal(SID, join(root, "proj"), "重启后重挂（#183）");
  const paths = (mgr2.getExternal(SID)?.artifacts ?? []).map((a) => a.path);
  assert(paths.includes(doc), "③ 重启挂回：deliver 登记条目从 artifacts-index.json 恢复");
  assert(paths.includes(art1), "③ 重启挂回：产物目录条目同恢复");
  const item = mgr2.getExternal(SID)?.artifacts?.find((a) => a.path === doc);
  assert(!!item?.tools.includes("登记") && item.exists !== false, "③ 挂回条目 tools=登记 且存活");
}

// ④ 旧扁平账迁移：独立 dataDir 预置 deliverables.json（含 unverified）→ 首启迁移
{
  const root2 = join(process.cwd(), ".tmp-test-artifacts-persist-mig");
  rmSync(root2, { recursive: true, force: true });
  mkdirSync(join(root2, "data"), { recursive: true });
  mkdirSync(join(root2, "proj"), { recursive: true });
  const legacy = join(root2, "proj", "旧账.md");
  writeFileSync(legacy, "# legacy");
  const legacyLink = join(root2, "proj", "旧账-link.md");
  writeFileSync(join(root2, "data", "deliverables.json"), JSON.stringify([
    { sid: "ext-old-1", path: legacy, ts: 1759900000000 },
    { sid: "ext-old-1", path: legacyLink, ts: 1759900001000, unverified: true },
    { sid: "", path: "/bad/no-sid.md", ts: 1759900002000 },
  ]));
  process.env.CCR_DATA_DIR = join(root2, "data");
  const cfg2 = loadConfig();
  const mgr3 = new SessionManager(new EventBus(), cfg2);
  const idx = JSON.parse(readFileSync(join(root2, "data", "artifacts-index.json"), "utf-8")) as Record<string, { path: string; delivered_at: number; unverified?: boolean }[]>;
  const migrated = idx["ext-old-1"] ?? [];
  assert(migrated.length === 2 && migrated.some((e) => e.path === legacy && e.delivered_at === 1759900000000), "④ 旧账迁移：好条目入 keyed 索引（delivered_at 承接 ts）");
  assert(migrated.some((e) => e.path === legacyLink && e.unverified === true), "④ 旧账迁移：unverified 标记传递");
  assert(!Object.keys(idx).some((k) => k === ""), "④ 旧账迁移：空 sid 行不迁");
  mgr3.ensureExternal("ext-old-1", join(root2, "proj"), "迁移账挂回");
  const paths3 = (mgr3.getExternal("ext-old-1")?.artifacts ?? []).map((a) => a.path);
  assert(paths3.includes(legacy), "④ 迁移条目可挂回");
  const rem = mgr3.getExternal("ext-old-1")?.artifacts?.find((a) => a.path === legacyLink) as { unverified?: boolean } | undefined;
  assert(rem?.unverified === true, "④ 挂回条目 unverified 还原");
  // 空索引在即权威：摘空的账不回灌旧数据
  writeFileSync(join(root2, "data", "artifacts-index.json"), "{}");
  const mgr4 = new SessionManager(new EventBus(), cfg2);
  mgr4.ensureExternal("ext-old-1", join(root2, "proj"), "空索引权威");
  assert((mgr4.getExternal("ext-old-1")?.artifacts ?? []).length === 0, "④ 空索引文件在即权威：不回灌旧 deliverables.json");
  rmSync(root2, { recursive: true, force: true });
  process.env.CCR_DATA_DIR = join(root, "data");
}

// ⑤ 删除同步：unlink → re-stat 翻 exists=false → 账本摘除；state 保留 dead 条目
unlinkSync(art1);
(mgr as unknown as { pollArtifactsExistence(): void }).pollArtifactsExistence();
{
  const entries = readIndex()[SID] ?? [];
  assert(!entries.some((e) => e.path === art1), "⑤ 产物删除后账本同步摘除");
  assert(entries.some((e) => e.path === doc), "⑤ 存活条目不受殃及");
  const internal = mgr.getExternal(SID)?.artifacts;
  assert(internal?.some((a) => a.path === art1 && a.exists === false) === true, "⑤ 内存 state 保留 dead 条目（#224 语义不回归）");
}

// 收尾再验一次重启面：摘除后的账本重启不再挂回已删产物
{
  const mgr5 = new SessionManager(new EventBus(), cfg);
  mgr5.ensureExternal(SID, join(root, "proj"), "删除后再重启");
  const paths5 = (mgr5.getExternal(SID)?.artifacts ?? []).map((a) => a.path);
  assert(!paths5.includes(art1) && paths5.includes(doc), "⑤ 删除条目重启不复活，存活条目照常挂回");
}

rmSync(root, { recursive: true, force: true });
console.log("\n全部通过");
