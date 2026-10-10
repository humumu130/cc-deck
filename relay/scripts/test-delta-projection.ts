// UPDATED delta 投影测试（M13-2）。
// 派单文目标：「让 PROJECTS_UPDATED/BOARD_UPDATED 同时保旧字段和 entity_ref+delta；
// 旧端忽略新字段；重复 delta 幂等」。三个必答的测试锁：
//   ① delta 形状锁——PROJECTS_UPDATED 携 EntityDelta<ProjectGroup>（upserts 按 id 全量条目 +
//      removes 按 id）、BOARD_UPDATED 携 BoardDelta（entries/lessons 两 EntityDelta + meta{frozen,
//      updated_at}）；entity_refs 恒为 upserts∪removes 的去重 id 集；首帧（发射缓存冷）省略
//      delta/entity_refs=覆盖式语义，与旧 relay 帧同形。
//   ② 幂等锁——同状态重复发射帧级深等（JSON.stringify）；delta 全部用带稳定 id 的完整条目
//      表达 → 参考端 merge（按 id upsert、removes 剔除、未知 id 忽略）对同一帧二次应用零变化；
//      全帧 merge 链终态 == 覆盖式（只认旧字段 board/groups）终态 == 板文件现值。
//   ③ 锚定纪律锁（M13-REV P1）——未锚定（无覆盖式帧起底）收 delta 帧=跳帧丢弃，
//      禁止「基线缺失→空集/空板起底 merge」（瞬态 seq:0 不补发+板域无 SNAPSHOT 兜底，
//      三端照抄空板起底即掉帧静默错乱；参考实现 anchor/prev undefined → 返回未定义）。
//   ④ 双出口同步锁（#117）——同一 emitTransient 帧经 LAN（ws-server 总线转发）与 phone
//      （cloud-client 密封转发）各收一份，payload 序列化深等；快照面 v2 信号位在 M13-1 件锁，
//      此处 wire 复证事件帧通道同构。
// 隔离：mgr 级段直连 EventBus 捕获；wire 段真桥（cloud-bridge 本地件）端口 8792/8793，
// 临时 dataDir，不触生产 8787、不触 ~/.cc-deck 组织数据。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startCloudServer } from "../../cloud-bridge/src/index.js";
import { EventBus } from "../src/event-bus.js";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import { CloudClient } from "../src/cloud-client.js";
import { startServer } from "../src/ws-server.js";
import { loadOrCreateIdentity } from "../src/cloud-identity.js";
import { createPairingCodes } from "../src/pairing.js";
import { devId, generateKeyPair, seal, unseal, type SealedBox } from "../src/e2e.js";
import {
  addLesson,
  listGroups,
  loadBoard,
  moveBoardEntry,
  removeBoardEntry,
  setGroupStatus,
  setLightConfirmTrusted,
  upsertBoardEntry,
  type BoardEntry,
  type LessonEntry,
  type ProjectBoard,
  type ProjectGroup,
} from "../src/projects.js";
import type { BoardUpdatedPayload, Command, Envelope, ProjectsUpdatedPayload } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "cc-deck-m13-delta-"));
let pass = 0;
let fail = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    pass++;
    console.log(`PASS ${message}`);
  } else {
    fail++;
    console.error(`FAIL ${message}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 25): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await wait(every);
  }
  return fn();
}

// 参考端 merge 实现（回单「delta payload 形状规格」的可执行演示：三端照此实现）。
// 帧级判定：payload.delta !== undefined → 增量 merge；缺席 → 覆盖式消费旧字段。
// 锚定纪律（M13-REV P1 回炉，与 types.ts 规格注释同源）：delta 帧仅可在锚定后应用
//（PROJECTS 域锚=SNAPSHOT.projects 或任一覆盖式帧；BOARD 域锚=该 gid 覆盖式帧——板域
// 无 SNAPSHOT 兜底，瞬态 seq:0 重连不补发）。anchor/prev === undefined（未锚定）收
// delta 帧 → 返回 undefined 跳帧（端上=丢弃+重拉重锚）；「基线缺失→空集/空板起底
// merge」是禁止路径。覆盖式帧兼任锚定帧：先到先锚。
function applyProjectsFrame(anchor: ProjectGroup[] | undefined, p: ProjectsUpdatedPayload): ProjectGroup[] | undefined {
  if (!p.delta) return [...p.groups]; // 覆盖式帧：同时完成锚定
  if (anchor === undefined) return undefined; // 未锚定 → 跳帧（禁止空集起底）
  const next = new Map(anchor.map((g) => [g.id, g]));
  for (const id of p.delta.removes) next.delete(id); // 未知 id 删除=no-op（幂等天然）
  for (const g of p.delta.upserts) next.set(g.id, g); // 按 id 整条替换
  return [...next.values()];
}
function applyBoardFrame(prev: ProjectBoard | undefined, gid: string, p: BoardUpdatedPayload): ProjectBoard | undefined {
  if (!p.delta) return p.board; // 覆盖式帧：同时完成锚定
  if (prev === undefined) return undefined; // 未锚定 → 跳帧（禁止空板起底；端上丢弃+COMMAND_PROJECT_DETAIL 重拉）
  const base: ProjectBoard = prev;
  const entries = new Map(base.entries.map((e) => [e.id, e]));
  for (const id of p.delta.entries.removes) entries.delete(id);
  for (const e of p.delta.entries.upserts) entries.set(e.id, e);
  const lessons = new Map((base.lessons ?? []).map((l) => [l.id, l]));
  for (const id of p.delta.lessons.removes) lessons.delete(id);
  for (const l of p.delta.lessons.upserts) lessons.set(l.id, l);
  return { ...base, entries: [...entries.values()], lessons: [...lessons.values()], frozen: p.delta.meta.frozen, updated_at: p.delta.meta.updated_at };
}

try {
  // ---------- 段 1：mgr 级 PROJECTS_UPDATED 形状 + 差分正确性 ----------
  console.log("S1 PROJECTS_UPDATED delta 形状");
  const dataDir = join(root, "data");
  process.env.CCR_STORAGE_READ_MODE = "json"; // 显式钉档（SQLITE-FLIP 后缺省=sqlite，fixture 是 json 形态——缺省读空库；75-R 回归发现的漏网连带面）
  process.env.CCR_DATA_DIR = dataDir;
  process.env.CCR_ORG_DIR = join(root, "org"); // 组织域数据（groups/boards）注入临时目录
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_WATCHDOG_DISABLE = "1";
  delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
  setLightConfirmTrusted(true); // 轻立项信任直通：create 即 active（板可写），省决议步（m12-commands 同款前置）

  const bus = new EventBus();
  const frames: Envelope[] = [];
  bus.subscribe((env) => {
    if (env.type === "PROJECTS_UPDATED" || env.type === "BOARD_UPDATED") frames.push(env);
  });
  const mgr = new SessionManager(bus, loadConfig());

  // 首帧：发射缓存冷 → 覆盖式（省略 delta/entity_refs，与旧 relay 帧同形）
  mgr.emitOrgState();
  const first = frames.find((f) => f.type === "PROJECTS_UPDATED")!.payload as ProjectsUpdatedPayload;
  assert(Array.isArray(first.groups) && !("delta" in first) && !("entity_refs" in first), "PROJECTS_UPDATED 首帧覆盖式：groups 全量在场、delta/entity_refs 省略（缓存冷语义）");

  // 轻立项建组（命令面真实路径，处理内自动 emitOrgState）→ 第二帧带 delta
  const ackG = mgr.handleCommand(
    { command_id: "d-g1", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "M13-2 测试组", anchor_dir: dataDir, tier: "轻立项" }, ts: Date.now() },
    "web-d",
  ) as { ok: boolean; data?: { group?: { id: string } } };
  const gid = ackG.data?.group?.id ?? "";
  assert(ackG.ok === true && gid !== "", "轻立项建组成功（真实命令面路径）");
  const createFrame = frames.filter((f) => f.type === "PROJECTS_UPDATED").at(-1)!.payload as ProjectsUpdatedPayload;
  assert(!!createFrame.delta && createFrame.delta.upserts.length === 1 && createFrame.delta.upserts[0]!.id === gid && createFrame.delta.removes.length === 0, "第二帧 delta.upserts 恰含新组、removes 空");
  assert(
    !!createFrame.entity_refs && createFrame.entity_refs.length === 1 && createFrame.entity_refs[0] === gid,
    "entity_refs == upserts∪removes 去重 id 集",
  );
  assert(Array.isArray(createFrame.groups) && createFrame.groups.some((g) => g.id === gid), "旧字段 groups 仍全量在场（旧端消费输入保留）");
  //（首参 [] = 已锚定空集——模拟 SNAPSHOT.projects=[] 后收到 create delta；undefined 才是未锚定跳帧态）
  assert(JSON.stringify(applyProjectsFrame([], createFrame)) === JSON.stringify(createFrame.groups), "已锚定空集收 create delta：merge == groups 覆盖终态（两消费路径起点一致）");

  // ---------- 段 2：BOARD_UPDATED delta 全谱（直调板函数 + emitBoard 发射） ----------
  console.log("S2 BOARD_UPDATED delta 全谱");
  const boardFrames = () => frames.filter((f) => f.type === "BOARD_UPDATED" && (f.payload as BoardUpdatedPayload).gid === gid);
  const lastBoardFrame = () => boardFrames().at(-1)!.payload as BoardUpdatedPayload;

  mgr.emitBoard(gid);
  const bf1 = lastBoardFrame();
  assert(Array.isArray(bf1.board.entries) && !("delta" in bf1) && !("entity_refs" in bf1), "BOARD 首帧覆盖式：board 全量在场、delta/entity_refs 省略（该 gid 缓存冷）");

  const rA = upsertBoardEntry(gid, { text: "卡A", status: "backlog" });
  assert(rA.ok === true, "前置：卡A 落板");
  mgr.emitBoard(gid);
  const bfA = lastBoardFrame();
  const entryA = bfA.delta!.entries.upserts[0]!;
  assert(bfA.delta!.entries.upserts.length === 1 && entryA.text === "卡A" && entryA.status === "backlog", "卡A 帧差分恰一 upsert（完整条目带正文）");
  assert(bfA.delta!.entries.removes.length === 0 && bfA.delta!.lessons.upserts.length === 0 && bfA.delta!.lessons.removes.length === 0, "无变化域差分为空集（entries/lessons 独立差分）");
  assert(bfA.entity_refs![0] === entryA.id, "BOARD entity_refs 收录条目 id");
  assert(bfA.board.entries.some((e) => e.id === entryA.id), "旧字段 board 仍全量在场");

  const rB = upsertBoardEntry(gid, { text: "卡B", status: "backlog" });
  assert(rB.ok === true, "前置：卡B 落板");
  mgr.emitBoard(gid);
  const bfB = lastBoardFrame();
  assert(bfB.delta!.entries.upserts.length === 1 && bfB.delta!.entries.upserts[0]!.text === "卡B", "加卡B 帧：差分只含新卡（已有卡不重复下发）");

  const rMv = moveBoardEntry(gid, entryA.id, "claimed");
  assert(rMv.ok === true, "前置：卡A todo→doing");
  mgr.emitBoard(gid);
  const bfMv = lastBoardFrame();
  assert(bfMv.delta!.entries.upserts.length === 1 && bfMv.delta!.entries.upserts[0]!.id === entryA.id && bfMv.delta!.entries.upserts[0]!.status === "claimed", "改状态帧：upserts 携 A 完整条目新 status（状态迁移=条目级 upsert）");

  const rRm = removeBoardEntry(gid, entryA.id);
  assert(rRm.ok === true, "前置：删除卡A");
  mgr.emitBoard(gid);
  const bfRm = lastBoardFrame();
  assert(bfRm.delta!.entries.removes.length === 1 && bfRm.delta!.entries.removes[0] === entryA.id && bfRm.delta!.entries.upserts.length === 0, "删卡帧：差分走 removes（删除边真实存在，非恒空形状）");

  const rL = addLesson(gid, { text: "M13-2 教训：delta 按稳定 id 表达" });
  assert(rL.ok === true, "前置：lesson 回流落板");
  mgr.emitBoard(gid);
  const bfL = lastBoardFrame();
  // W-EXPP1 读侧退役（2026-10-10）：lessons 不再随板下发（§0 摘要不再下发，端上缓存
  // 靠首发 removes 清空）——lesson 写动不再产生 lessons.upserts 差分，也不污染 entries
  assert(bfL.delta!.lessons.upserts.length === 0 && (bfL.delta!.lessons.removes ?? []).length === 0, "W-EXPP1：lesson 写动零差分（lessons 域退役不下发）");
  assert(bfL.delta!.entries.upserts.length === 0 && bfL.delta!.entries.removes.length === 0, "lesson 变动不污染 entries 差分");
  assert(Array.isArray((bfL.board as { lessons?: unknown[] }).lessons) && ((bfL.board as { lessons?: unknown[] }).lessons ?? []).length === 0, "W-EXPP1：板下发载荷不带 lessons");

  // 冻结翻转（组 parked → 板 frozen）：meta 承载非条目变更
  //（命令联合类型只冻结 create variant；status 变体是 session-manager 内部面，测试侧 as 放行）
  //（orgAction 命令漏斗只认 task/dispatch/lesson 四动作；组状态迁移走 store 层真实路径
  // setGroupStatus——内部 freezeBoard 翻转与命令面同函数）
  const rPark = setGroupStatus(gid, "parked");
  assert(rPark.ok === true, "前置：组 parked（冻结翻转随板广播，store 层真实路径）");
  mgr.emitBoard(gid); // store 直调不经 mgr——广播显式触发（命令面内部同款调用）
  const bfPark = lastBoardFrame();
  assert(bfPark.delta!.meta.frozen === true && bfPark.board.frozen === true, "冻结翻转经 delta.meta.frozen=true 下发（meta 承载非条目变更）");
  assert(bfPark.delta!.meta.updated_at === bfPark.board.updated_at, "meta.updated_at 与 board.updated_at 同源同值");

  // ---------- 段 2.5：M13-REV P3-2 读失败跳帧（坏板文件→零帧→恢复→下帧照常差分） ----------
  // 语义：读失败≠空板——外部改板半态/磁盘抖动不得差分出「整板 removes」清板广播
  //（UI 闪断+半态扩散）；前值缓存不动，文件恢复后下帧照常差分。
  console.log("S2.5 P3-2 读失败跳帧");
  {
    const boardPath = join(root, "org", "boards", `${gid}.json`);
    const before = boardFrames().length;
    const goodSnapshot = readFileSync(boardPath, "utf-8"); // 现值快照（恢复用）
    writeFileSync(boardPath, "{ bad-half-state"); // 外部改板半态（坏 JSON）
    mgr.emitBoard(gid);
    assert(boardFrames().length === before, "P3-2 坏板文件：emitBoard 零帧发射（跳帧，不出整板 removes 清板帧）");
    writeFileSync(boardPath, goodSnapshot); // 文件恢复（外部修好，同值）
    mgr.emitBoard(gid);
    assert(boardFrames().length === before + 1, "P3-2 文件恢复后下帧恢复发射");
    const rec = lastBoardFrame();
    assert(
      rec.delta!.entries.upserts.length === 0 && rec.delta!.entries.removes.length === 0 && rec.delta!.lessons.upserts.length === 0 && rec.delta!.lessons.removes.length === 0,
      "P3-2 前值缓存未被坏读污染：恢复帧 diff 基线=跳帧前成功板（同值空差分，无幽灵 removes/upserts）",
    );
    // 反证：恢复文件带真新条目 → 下帧正确差分出该条（跳帧语义不吞真变更）
    const revived = JSON.parse(goodSnapshot) as ProjectBoard;
    revived.entries = [...revived.entries, { id: "p32-new", text: "P3-2 恢复后新条目", status: "backlog", ts: Date.now(), updated_at: Date.now() } as BoardEntry];
    revived.updated_at = Date.now();
    writeFileSync(boardPath, JSON.stringify(revived, null, 2) + "\n");
    mgr.emitBoard(gid);
    const rec2 = lastBoardFrame();
    assert(rec2.delta!.entries.upserts.length === 1 && rec2.delta!.entries.upserts[0]!.id === "p32-new", "P3-2 文件恢复+真变更：下帧正确差分出新增条目（跳帧不吞真变更）");
    // 恢复文件写回现值（不污染后续段）
    writeFileSync(boardPath, goodSnapshot);
    mgr.emitBoard(gid);
  }

  // ---------- 段 3：幂等锁（同帧深等 + merge 二次应用零变化 + merge 链 == 覆盖链） ----------
  console.log("S3 幂等与一致性");
  const before = frames.length;
  mgr.emitBoard(gid);
  mgr.emitBoard(gid);
  const idem1 = frames.at(-2)!.payload as BoardUpdatedPayload;
  const idem2 = frames.at(-1)!.payload as BoardUpdatedPayload;
  assert(frames.length === before + 2, "前置：同状态连续发射产出两帧");
  assert(JSON.stringify(idem1) === JSON.stringify(idem2), "同状态重复发射：两帧序列化深等（帧级稳定）");

  // merge 链重放：全帧按序消费（首帧覆盖起底，后帧 delta merge）→ 与板文件现值深等
  let mergedEntries = new Map<string, BoardEntry>();
  let mergedLessons = new Map<string, LessonEntry>();
  let mergedFrozen = false;
  let mergedAt = 0;
  let primed = false;
  //（覆盖链终态同口径比对）
  for (const f of boardFrames()) {
    const p = f.payload as BoardUpdatedPayload;
    if (!p.delta) {
      mergedEntries = new Map(p.board.entries.map((e) => [e.id, e]));
      mergedLessons = new Map((p.board.lessons ?? []).map((l) => [l.id, l]));
      mergedFrozen = p.board.frozen;
      mergedAt = p.board.updated_at;
      primed = true;
      continue;
    }
    assert(primed, "delta 帧前必有覆盖式起底帧（重启语义正确性）");
    for (const id of p.delta.entries.removes) mergedEntries.delete(id);
    for (const e of p.delta.entries.upserts) mergedEntries.set(e.id, e);
    for (const id of p.delta.lessons.removes) mergedLessons.delete(id);
    for (const l of p.delta.lessons.upserts) mergedLessons.set(l.id, l);
    mergedFrozen = p.delta.meta.frozen;
    mergedAt = p.delta.meta.updated_at;
  }
  const live = loadBoard(gid);
  // W-EXPP1 读侧退役：lessons 不随帧下发 → merge 链 lessons 终态恒空（板文件内冻结
  // 数据不参与消费面），entries/meta 照旧与文件收敛一致
  assert(
    JSON.stringify([...mergedEntries.values()]) === JSON.stringify(live.entries) &&
      mergedLessons.size === 0 &&
      mergedFrozen === live.frozen &&
      mergedAt === live.updated_at,
    "全帧 merge 链终态 == 板文件现值（lessons 退役恒空——W-EXPP1；entries/meta 照旧收敛）",
  );
  // 覆盖链：只认旧字段（旧端行为）→ 同一终态（lessons 摘除后下发）
  const covered = boardFrames().at(-1)!.payload as BoardUpdatedPayload;
  assert(JSON.stringify(covered.board) === JSON.stringify({ ...live, lessons: [] }), "全帧覆盖链（只认 board 旧字段）终态同收敛（lessons 摘除——W-EXPP1）");
  // 同一 delta 二次应用零变化
  const twice = applyBoardFrame({ ...live, entries: [...live.entries], lessons: [...(live.lessons ?? [])] }, gid, lastBoardFrame());
  assert(JSON.stringify(twice) === JSON.stringify(live), "对已收敛状态二次应用同一 delta：零变化（重复投递幂等）");
  // 锚定纪律锁（M13-REV P1 回炉）：未锚定收 delta 帧 = 跳帧，禁止空集/空板起底
  assert(applyBoardFrame(undefined, gid, lastBoardFrame()) === undefined, "未锚定收 BOARD delta 帧：参考实现跳帧（返回未定义，不产出空板起底错乱终态）");
  assert(applyProjectsFrame(undefined, createFrame) === undefined, "未锚定收 PROJECTS delta 帧：参考实现跳帧");

  // ---------- 段 4：重启首帧（发射缓存冷 = 无 delta 键，覆盖式兜底） ----------
  console.log("S4 重启首帧");
  const bus2 = new EventBus();
  const frames2: Envelope[] = [];
  bus2.subscribe((env) => {
    if (env.type === "BOARD_UPDATED") frames2.push(env);
  });
  const mgr2 = new SessionManager(bus2, loadConfig());
  mgr2.emitBoard(gid);
  const reboot = frames2.at(-1)!.payload as BoardUpdatedPayload;
  // W-EXPP1：重启首帧=覆盖式起底 + lessons 清缓存 purge（文件内有冻结 lessons 时
  // delta.lessons.removes 列全量 id；无 lessons 时保持无 delta 旧形状）
  const fileLessonIds = (loadBoard(gid).lessons ?? []).map((l) => l.id);
  assert(Array.isArray(reboot.board.entries) && (reboot.board.lessons ?? []).length === 0, "重启后 BOARD 首帧覆盖式（board 载荷不带 lessons——W-EXPP1）");
  if (fileLessonIds.length > 0) {
    assert("delta" in reboot && JSON.stringify(reboot.delta!.lessons.removes) === JSON.stringify(fileLessonIds), "重启首帧带 lessons 清缓存 purge（removes=文件冻结 id 全集——W-EXPP1）");
  } else {
    assert(!("delta" in reboot), "重启后 BOARD 首帧无 delta（缓存冷覆盖式，端上兜底路径）");
  }

  // ---------- 段 5：双出口同步 wire 锁（#117 事件面） ----------
  console.log("S5 双出口事件帧同步");
  const BRIDGE_PORT = 8792;
  const RELAY_PORT = 8793;
  process.env.CCR_CLOUD_URL = `ws://127.0.0.1:${BRIDGE_PORT}/cloud`;
  process.env.CCR_CLOUD_TOKEN = "m132-token";
  process.env.CCR_PORT = String(RELAY_PORT);
  const wDir = join(root, "wire-data"); // 挂在 root 下，finally 一并清
  mkdirSync(wDir, { recursive: true });
  process.env.CCR_DATA_DIR = wDir;
  process.env.CCR_ORG_DIR = join(wDir, "org");
  setLightConfirmTrusted(true); // trust 面随 org 目录持久化，换目录重开一次
  const bridge = startCloudServer(BRIDGE_PORT, "m132-token");
  void bridge;
  const cfg3 = loadConfig();
  const bus3 = new EventBus();
  const mgr3 = new SessionManager(bus3, cfg3);
  const identity = loadOrCreateIdentity(wDir);
  mgr3.setCloud(identity);
  const pairCodes = createPairingCodes();
  mgr3.setPairIssuer((o) => pairCodes.issue(o));
  const srv = await startServer(bus3, mgr3, cfg3, {
    cloudRelayDev: () => identity.relayDev,
    cloudWanDev: () => identity.wanDev,
    relayName: () => "delta-relay",
    lanHint: () => `127.0.0.1:${RELAY_PORT}`,
  });
  assert(srv.port === RELAY_PORT, `LAN 出口绑定测试端口 ${RELAY_PORT}（远隔生产 8787）`);
  const cloud = new CloudClient(bus3, mgr3, cfg3, identity, pairCodes, undefined, {
    lanHint: () => `127.0.0.1:${RELAY_PORT}`,
    relayName: () => "delta-relay",
  });
  cloud.start();
  await wait(300);

  // LAN 客户端（明文 ws，token 鉴权）
  const lanInbox: Envelope[] = [];
  const lanWs = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws?token=${encodeURIComponent(cfg3.token)}&last_seq=0`);
  lanWs.on("message", (raw) => lanInbox.push(JSON.parse(String(raw)) as Envelope));
  lanWs.on("error", () => undefined);
  await new Promise<void>((r) => lanWs.on("open", r));

  // phone（真桥密封通道）
  const phoneKp = generateKeyPair();
  const phoneDev = devId(phoneKp.publicKey, "ph");
  const pairAck = mgr3.handleCommand(
    { command_id: "d-pair", type: "COMMAND_PAIR_START", payload: { pubkey: phoneKp.publicKey, name: "delta手机" }, ts: Date.now() },
    "web-d",
  ) as { ok: boolean; cloud?: { relay_dev: string; relay_pubkey: string } };
  assert(pairAck.ok === true && !!pairAck.cloud, "手机配对成功");
  const relayPub = pairAck.cloud!.relay_pubkey;
  const phoneWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=m132-token&dev=${phoneDev}`);
  const phoneInbox: Envelope[] = [];
  phoneWs.on("message", (raw) => {
    const f = JSON.parse(String(raw)) as { data?: SealedBox };
    if (f.data) {
      const inner = unseal<Envelope>(f.data, relayPub, phoneKp.secretKey);
      if (inner) phoneInbox.push(inner);
    }
  });
  phoneWs.on("error", () => undefined);
  await new Promise<void>((r) => phoneWs.on("open", r));
  // 手机 hello 激活（cloud-client 端 st.active 门：hello 前不下发任何帧）
  phoneWs.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "hello", last_seq: 0 }, relayPub, phoneKp.secretKey) }));
  await wait(200);

  // 触发一帧 PROJECTS_UPDATED + 一帧 BOARD_UPDATED，双出口各收一份
  const ackG2 = mgr3.handleCommand(
    { command_id: "d-g2", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "双出口组", anchor_dir: wDir, tier: "轻立项" }, ts: Date.now() },
    "web-d",
  ) as { ok: boolean; data?: { group?: { id: string } } };
  const gid2 = ackG2.data?.group?.id ?? "";
  assert(ackG2.ok === true && gid2 !== "", "wire 段前置：建组成功");
  mgr3.emitBoard(gid2); // 预热：该 gid 发射缓存冷的首帧覆盖式（与旧帧同形，双出口也应同收）
  await wait(150);
  upsertBoardEntry(gid2, { text: "wire 卡", status: "backlog" });
  mgr3.emitBoard(gid2); // 差分帧

  //（filter 在 waitFor 回调内动态求值——固化快照会漏掉轮询间隙到达的帧）
  const lanProjs = () => lanInbox.filter((f) => f.type === "PROJECTS_UPDATED");
  const lanBoards = () => lanInbox.filter((f) => f.type === "BOARD_UPDATED");
  const phProjs = () => phoneInbox.filter((f) => f.type === "PROJECTS_UPDATED");
  const phBoards = () => phoneInbox.filter((f) => f.type === "BOARD_UPDATED");
  assert(
    await waitFor(() => lanProjs().length > 0 && lanBoards().length >= 2 && phProjs().length > 0 && phBoards().length >= 2), // 等「预热覆盖帧+差分帧」两帧齐（at(-1) 才是差分帧）
    "LAN 与 phone 双出口各收到 PROJECTS_UPDATED + BOARD_UPDATED 帧瞬态转发",
  );
  assert(lanProjs().length === phProjs().length && lanBoards().length === phBoards().length, "双出口帧数一致（同帧双份，无单边丢失）");
  const lp = lanProjs().at(-1)?.payload as ProjectsUpdatedPayload | undefined;
  const pp = phProjs().at(-1)?.payload as ProjectsUpdatedPayload | undefined;
  assert(!!lp && !!pp && JSON.stringify(lp) === JSON.stringify(pp), "PROJECTS_UPDATED 双出口 payload 深等（#117 事件面）");
  const lb = lanBoards().at(-1)?.payload as BoardUpdatedPayload | undefined;
  const pb = phBoards().at(-1)?.payload as BoardUpdatedPayload | undefined;
  assert(!!lb && !!pb && JSON.stringify(lb) === JSON.stringify(pb), "BOARD_UPDATED 双出口 payload 深等（#117 事件面）");
  assert(!!lb?.delta && lb.delta.entries.upserts.some((e) => e.text === "wire 卡"), "wire 帧 delta 内容正确（非空差分经双出口原样透传）");
  assert(lp?.delta !== undefined || Array.isArray(lp?.groups), "PROJECTS_UPDATED wire 帧形状合法");

  // 旧端忽略新字段：模拟旧客户端只读旧键（groups/board），新键存在但消费无感
  const legacyBoardView = pb ? { gid: pb.gid, board: pb.board } : undefined;
  assert(!!legacyBoardView && Array.isArray(legacyBoardView.board.entries) && Array.isArray(lp?.groups), "旧端视角只消费 board/groups 旧字段照常可用（新键并存不破坏）");

  lanWs.close();
  phoneWs.close();
  cloud.close();
  await srv.close();
  await bridge.close();

  console.log(`M13-2 delta projection: ${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.error("FATAL", err);
  process.exit(1);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}
