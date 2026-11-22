// CONNV4 批D（connv4d）：源列表 LAN 段 web 探针——渲染链+发起动作+快照消费（行为级）。
// 范式：真源码抽取直跑（test-280-conn-page 同款 blockFrom+link），靶子
// web-console/js/settings-domain.js 的 lanPeersRows/lanConnectSend/fetchLanPeers/sourceListRows。
//
// 断言组：
//   L 渲染链：LAN 段在五段序段4 位（acct 之后、配对码源之前）· 组播不可用/空邻居/无数据=段隐藏
//   R 行渲染：四态（待连发起钮/等待确认/已同意+未验证灰标/对方已拒绝）· 「局域网」小标 ≤3 字
//             · 同账号设备不双列（acct 段已列）
//   A 发起动作：POST lan-connect-send {dev, op:"request"} · 响应态映射 toast · 发起后强刷
//   S 快照消费：5s 节流 · 无 token 不发 · 失败静默（段隐藏非报错）
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-lanpeers-web.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sd = readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.error("  FAIL " + name); }
}
function blockFrom(needle: string): string {
  const i = sd.indexOf(needle);
  if (i < 0) return "";
  const j = sd.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < sd.length; k++) {
    if (sd[k] === "{") depth++;
    else if (sd[k] === "}") { depth--; if (depth === 0) return sd.slice(i, k + 1); }
  }
  return "";
}
function link(block: string, params: string[], deps: Record<string, unknown>, isAsync = false): (...a: unknown[]) => unknown {
  // async 源函数须用 AsyncFunction 构造（new Function 不认 body 里的 await）
  const Ctor = isAsync ? ((Object.getPrototypeOf(async function () {}) as unknown as { constructor: FunctionConstructor }).constructor) : Function;
  const f = new Ctor(...params, "__D", "with (__D) {" + block.slice(block.indexOf("{") + 1, block.lastIndexOf("}")) + "}");
  return (...a: unknown[]) => { const p = [...a]; while (p.length < params.length) p.push(undefined); return f(...p, deps); };
}

console.log("CONNV4 批D 源列表 LAN 段 web 探针");

// ---------- 公共依赖替身 ----------
const mkDeps = () => ({
  esc: (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c: string) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string),
  srcTagHtml: (kind: string) => '<span class="tag" title="来源：' + kind + '">' + kind + "</span>",
  acctAcctRelays: () => [{ dev: "rl-sameacct0000", name: "同账号机", online: true }],
  acctApiBase: () => "http://127.0.0.1:8787",
  acctLanToken: () => "tok-123",
  showToast: (m: string) => { deps.toasts.push(m); },
  fetchLanPeers: () => { deps.refetch++; },
  window: {},
  Date,
  LAN_PEERS: { data: null, at: 0, busy: false },
  toasts: [] as string[],
  refetch: 0,
  fetchCalls: [] as Array<{ url: string; body?: string }>,
  fetchReply: { status: 200, json: { ok: true, status: "pending" } } as { status: number; json: { ok?: boolean; status?: string; error?: string } },
});
const deps = mkDeps() as ReturnType<typeof mkDeps> & { fetch: unknown };
deps.fetch = (async (url: unknown, init?: { body?: string }) => {
  (deps.fetchCalls as Array<{ url: string; body?: string }>).push({ url: String(url), body: init?.body });
  return { ok: deps.fetchReply.status === 200, status: deps.fetchReply.status, json: async () => deps.fetchReply.json };
});

const lanPeersRows = link(blockFrom("function lanPeersRows()"), [], deps) as () => string;
const lanConnectSend = link(blockFrom("async function lanConnectSend(dev)"), ["dev"], deps, true) as (d: string) => Promise<void>;
const fetchLanPeers = link(blockFrom("async function fetchLanPeers(force)"), ["force"], deps, true) as (f?: boolean) => Promise<void>;

// ---------- L 渲染链 ----------
{
  const PEERS = [
    { dev: "rl-aaaa1111", name: "邻居甲", pk: "pkA", ip: "192.168.1.10", port: 8787, ts: 1, conn: "none" },
    { dev: "rl-bbbb2222", name: "邻居乙", pk: "pkB", ip: "192.168.1.11", port: 8787, ts: 1, conn: "pending" },
    { dev: "rl-cccc3333", name: "邻居丙", pk: "pkC", ip: "192.168.1.12", port: 8787, ts: 1, conn: "confirmed" },
    { dev: "rl-dddd4444", name: "邻居丁", pk: "pkD", ip: "192.168.1.13", port: 8787, ts: 1, conn: "rejected" },
    { dev: "rl-sameacct0000", name: "同账号机", pk: "pkS", ip: "192.168.1.14", port: 8787, ts: 1, conn: "none" },
  ];
  (deps.LAN_PEERS as { data: unknown }).data = { ok: true, mdns: true, peers: PEERS, self: "rl-self000000" };
  const html = lanPeersRows();
  ok(html.includes("邻居甲") && html.includes("发起连接"), "L1 待连行：名字+发起连接钮（data-lan-connect）");
  ok(/data-lan-connect="rl-aaaa1111"/.test(html), "L1b 发起钮锚 dev（data-lan-connect=dev）");
  ok(html.includes("等待对方确认"), "L2 pending 行：等待对方确认 tag");
  ok(html.includes("已同意") && html.includes("未验证"), "L3 confirmed 行：已同意+未验证灰标（同意≠身份信任）");
  ok(html.includes("对方已拒绝"), "L4 rejected 行：对方已拒绝（拒绝记忆发起端可见）");
  ok((html.match(/<span class="tag" title="来源：局域网">局域网<\/span>/g) ?? []).length === 4, "L5 「局域网」小标逐行（≤3 字，中性灰 tag）");
  ok(!html.includes("rl-sameacct0000"), "L6 同账号设备不双列（acct 段已列——LAN 段过滤）");
  ok((html.match(/data-lan-connect/g) ?? []).length === 1, "L7 仅待连态给发起钮（其余三态无钮——防重复发起骚扰）");
  // 段隐藏三态
  (deps.LAN_PEERS as { data: unknown }).data = { ok: true, mdns: false, peers: PEERS, self: "rl-self" };
  ok(lanPeersRows() === "", "L8 组播不可用（mdns:false）→ 段隐藏非报错（验收点2）");
  (deps.LAN_PEERS as { data: unknown }).data = { ok: true, mdns: true, peers: [], self: "rl-self" };
  ok(lanPeersRows() === "", "L9 无邻居 → 段隐藏");
  (deps.LAN_PEERS as { data: unknown }).data = null;
  ok(lanPeersRows() === "", "L10 未拉到数据（https 云形态/拉取失败）→ 段隐藏");
  // 五段序静态锚：lanHtml 在 acctHtml 与 serversHtml 之间
  const slr = blockFrom("function sourceListRows()");
  ok(slr.includes("acctHtml + lanHtml + serversHtml"), "L11 五段序：本机+acct（在线→离线）+LAN+配对码（1117 排序口径——段4 位）");
  ok(slr.includes("!acctHtml && !lanHtml && !serversHtml"), "L11b 空态判定含 LAN 段（三段全空才空态）");
}

// ---------- A 发起动作 ----------
{
  (deps.LAN_PEERS as { data: unknown }).data = null;
  deps.fetchCalls.length = 0;
  deps.fetchReply = { status: 200, json: { ok: true, status: "pending" } };
  void lanConnectSend("rl-aaaa1111");
  await new Promise((r) => setTimeout(r, 20));
  const call = deps.fetchCalls[deps.fetchCalls.length - 1];
  ok(call?.url.includes("/api/lan-connect-send?token=tok-123"), "A1 发起走本机 relay（token 鉴权）");
  ok(call?.body === JSON.stringify({ dev: "rl-aaaa1111", op: "request" }), "A2 请求体 {dev, op:request}");
  ok(deps.toasts[deps.toasts.length - 1]?.includes("等待对方确认"), "A3 pending 响应 → toast「已发起 · 等待对方确认」");
  deps.fetchReply = { status: 200, json: { ok: true, status: "rejected" } };
  await lanConnectSend("rl-aaaa1111");
  ok(deps.toasts[deps.toasts.length - 1]?.includes("已拒绝"), "A4 rejected 响应 → toast 拒绝文案");
  deps.fetchReply = { status: 502, json: { ok: false, error: "邻居不在发现缓存" } };
  await lanConnectSend("rl-aaaa1111");
  ok(deps.toasts[deps.toasts.length - 1]?.includes("发起失败"), "A5 失败响应 → toast 人话错误");
  ok(deps.refetch >= 3, "A6 发起后强刷（at=0+fetchLanPeers(true)——状态即时回显）");
  // 点击委托静态锚
  ok(sd.includes('t.closest("[data-lan-connect]")'), "A7 点击委托挂载（data-lan-connect → lanConnectSend）");
}

// ---------- S 快照消费 ----------
{
  deps.fetchCalls.length = 0;
  (deps.LAN_PEERS as { at: number }).at = Date.now(); // 刚拉过
  void fetchLanPeers();
  await new Promise((r) => setTimeout(r, 10));
  ok(deps.fetchCalls.length === 0, "S1 5s 节流（窗口内不重发）");
  void fetchLanPeers(true);
  await new Promise((r) => setTimeout(r, 10));
  ok(deps.fetchCalls.length === 1 && deps.fetchCalls[0]?.url.includes("/api/lan-peers?token="), "S2 强刷直发（force 越节流）");
  // 无 token 不发
  (deps.acctLanToken as unknown as () => string) = () => "";
  deps.fetchCalls.length = 0;
  (deps.LAN_PEERS as { at: number }).at = 0;
  void fetchLanPeers();
  await new Promise((r) => setTimeout(r, 10));
  ok(deps.fetchCalls.length === 0, "S3 无 LAN token 不发（壳探测未命中形态——段隐藏）");
}

console.log(`\nLANPEERS-WEB TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
