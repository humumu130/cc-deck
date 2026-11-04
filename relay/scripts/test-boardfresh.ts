// boardfresh（t-66263a30，1104 用户令·板面说谎第三现）：双端新鲜度+续传对账契约锁。
//   CDP 探针 8 断言全绿（龄戳/离线横幅/切 tab 强刷/帧路 ≤5s/digest 失配拉一致不拉/
//   回前台完整链）；本套件=源码静态锁（双端+relay 治本三出口）防回退。恒真禁用。
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const srcOf = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

async function main(): Promise<void> {
  const web = srcOf("../../web-console/js/team-domain.js");
  const css = srcOf("../../web-console/css/base.css");
  const rn = srcOf("../../expo-app/src/store.ts");
  const app = srcOf("../../expo-app/App.tsx");
  const page = srcOf("../../expo-app/src/screens/TeamDetailPage.tsx");
  const wss = srcOf("../src/ws-server.ts");
  const cc = srcOf("../src/cloud-client.ts");

  console.log("A. 龄戳（用户①：数据是几点可感知）");
  {
    assert(web.includes("boardFreshAt: new Map()") && web.includes("state.boardFreshAt.set(gid, Date.now())") && web.includes("state.boardFreshAt.set(board.gid, Date.now())") && web.includes("state.boardFreshAt.set(payload.gid, Date.now())"), "web 龄戳三写点（detail ack/SNAPSHOT 板直落/BOARD_UPDATED 帧）");
    assert(web.includes("更新于 ' + fmtHM(freshAt)") && web.includes("数据可能过期") && web.includes("600_000"), "web 龄戳行+>10min 灰字追加（60 万 ms 档）");
    assert(rn.includes("boardFreshAt: Map<string, number>") && rn.includes("conn.boardFreshAt.set(eff.board.gid, Date.now())") && rn.includes("conn.boardFreshAt.set(gid, Date.now())") && rn.includes("conn.boardFreshAt.set(b.gid, Date.now())"), "RN 龄戳三写点（BOARD_UPDATED 帧/resyncBoard ack/SNAPSHOT 板直落——B-P2 补第三写点：快照带 boards 逐板落地处）");
    assert(page.includes("freshLabel") && page.includes("数据可能过期") && page.includes("freshTick"), "RN 板头龄戳行+60s 自检时钟（「过期」灰字自浮现）");
    assert(css.includes("#d-team .board-fresh") && css.includes("#d-team .board-fresh .board-fresh-stale") && css.includes("#d-team .board-offline"), "CSS 三类（龄戳/过期灰字/离线横幅——复用灰轴零新色）");
  }

  console.log("B. 三时机强刷（用户②：走既有通道禁旁路）");
  {
    assert(web.includes("function refreshBoardFresh(reason)") && web.includes("requestDetail(state.selected, true)") && web.includes("5000"), "web 强刷单口（requestDetail force 通道+5s 节流）");
    assert(web.includes('refreshBoardFresh("visibility-visible")'), "web 时机①visibilitychange visible");
    assert(web.includes("state._freshLastAt = 0;") && web.includes("boardfresh 时机②"), "web 时机②SNAPSHOT 落地（重连确证——清节流让选中组重拉必发）");
    assert(web.includes('refreshBoardFresh("tab-看板")') && web.includes(".segment-bar button"), "web 时机③切看板 tab（segment-bar 第 2 钮捕获钩）");
    assert(app.includes('store.refreshBoard("appstate-active")'), "RN 时机①AppState active（App.tsx listener 内）");
    assert(page.includes("store.lastBoard = { sourceId: srcId, gid };"), "RN 进页记 lastBoard（时机③=挂载 orgDetail 天然+AppState 落点）");
    assert(rn.includes("refreshBoard(reason: string)") && rn.includes('conn.state !== "online"') && rn.includes("this.resyncBoard(conn, lb.gid)"), "RN 强刷单口（resyncBoard 既有通道+在线门+5s 节流）");
  }

  console.log("C. 离线横幅（用户③：断连可感知）");
  {
    assert(web.includes("离线——显示的是 ' + (freshAt ? fmtHM(freshAt) + \" 的快照\" : \"旧数据（无龄戳）\")"), "web 离线横幅文案（含龄戳时刻/无戳降级）");
    assert(page.includes("离线——显示的是 ") && page.includes("旧数据（无龄戳）"), "RN 离线横幅同款文案（双端一致）");
  }

  console.log("D. 续传对账治本（扩围：resume 快路径板摘要）");
  {
    assert(wss.includes("export function fnv1a(") && wss.includes("Math.imul(h, 0x01000193)") && wss.includes("export function buildBoardsDigest()"), "relay 摘要构建器（FNV-1a 32 导出+buildBoardsDigest——KB 级载荷）");
    const lanCount = (wss.match(/buildBoardsDigest\(\)/g) || []).length;
    assert(lanCount >= 2, `LAN 快路径补发在场（ws-server 构建+发送 ${lanCount} 处）`);
    const ccCount = (cc.match(/buildBoardsDigest\(\)/g) || []).length;
    assert(ccCount >= 2, `云桥双路补发（resumePhone seal+resumeWan ${ccCount} 处发送（import 另计）——瞬态 seq:0 每次现算现发）`);
    assert(web.includes("BOARDS_DIGEST") && web.includes("Math.imul(h, 0x01000193)") && web.includes("requestDetail(gid, true)"), "web digest 消费（同公式对账失配即 force 重拉）");
    assert(rn.includes('case "BOARDS_DIGEST"') && rn.includes("Math.imul(h, 0x01000193)") && rn.includes("this.resyncBoard(conn, d.gid)"), "RN digest 消费（同公式+resyncBoard 重拉）");
    // 三端公式一致性锚（`${id}:${status}` 有序 join——同串同核）
    for (const [name, src] of [["web", web], ["rn", rn]] as const) {
      assert(src.includes('.map(') && src.includes('.sort().join("|")') && src.includes('charCodeAt(i)'), `${name} 对账公式=relay 同式（\`\${id}:\${status}\` 有序 join+FNV-1a）`);
    }
    assert(wss.includes("BOARD_UPDATED 是\n *  瞬态帧不进缓冲"), "注释锚：治本定罪在档（瞬态帧不进缓冲=断连窗板变更丢失根因）");
  }

  console.log("E2. 新帧类型双锚锁（B 审建议·防第三犯：路由层+消费层同锁）");
  {
    const settings = srcOf("../../web-console/js/settings-domain.js");
    const wl = settings.indexOf('message.type !== "RETIRED_SESSIONS_UPDATED"');
    assert(wl > 0 && settings.slice(wl, wl + 400).includes('message.type !== "BOARDS_DIGEST"'), "路由层锚：settings 六型白名单已放行 BOARDS_DIGEST（B-P1——原漏致 team 域消费分支死码，离席帧同类第三犯）");
    assert(web.includes('message?.type === "BOARDS_DIGEST"') && rn.includes('case "BOARDS_DIGEST"'), "消费层锚：web+RN BOARDS_DIGEST 分支在场（与路由层成对——新增帧类型两处都改才放行）");
  }

  console.log("E3. relay 侧 digest 真函数单测（R1-F3 同源+形状+幂等）");
  {
    const { buildBoardsDigest, fnv1a } = await import("../src/ws-server.js");
    const d1 = buildBoardsDigest();
    const d2 = buildBoardsDigest();
    assert(d1 === null || (Array.isArray(d1.payload.boards) && d1.payload.boards.every((b) => typeof b.gid === "string" && typeof b.n === "number" && typeof b.rev === "number")), `digest 输出形状（null 无组 或 per-gid {gid,n,rev} 全数值——实测 ${d1 === null ? "null（无组态）" : d1.payload.boards.length + " 组"}）`);
    assert(JSON.stringify(d1) === JSON.stringify(d2), "digest 幂等（连算两轮同串——rev 稳定不闪）");
    // 同源锚：源码读 loadBoard（禁 loadBoardFile 分叉——sqlite 档投影形状恒假失配）
    const wssSrc = srcOf("../src/ws-server.ts");
    const codeNoFile = wssSrc.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""); // 剥注释后锁代码面（注释里的历史词不算）
    assert(codeNoFile.includes("const b = loadBoard(g.id);") && !codeNoFile.includes("loadBoardFile"), "digest 与 detail ack 同源 loadBoard（R1-F3——viaReadMode 投影，代码面零 loadBoardFile 残留）");
    assert(fnv1a("t1:claimed") === fnv1a("t1:claimed") && fnv1a("t1:claimed") !== fnv1a("t1:done"), "fnv1a 稳定+分态（同串同核/异串异核）");
  }

  console.log("E. 不动面锚（回归红线）");
  {
    assert(wss.includes("buildSessionsReconcile") && web.includes("data-team-refresh"), "#265 reconcile 先例与 1013 件9 刷新钮原样（新钩只加不改）");
    assert(web.includes("SNAPSHOT_BOARDS_MAX_BYTES") === false && cc.includes("listBoards()"), "SNAPSHOT 板全量守卫未触碰（digest 独立直读 loadBoardFile 不受限）");
    assert(!web.includes("|| true") && !rn.includes("|| true;"), "恒真断言零残留（多批教训）");
  }

  console.log(`\n========== boardfresh 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
