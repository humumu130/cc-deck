// ---------- P0-3/T1（DEV-43）：云桥直推手机告警（relay 侧外发单口） ----------
// 桥侧新增 POST /alert（cloud-bridge/src/alert.ts 单源、CF/Node 双形态同构）：
// 定向把明文 bridge_alert 帧投给在线手机——不经 relay 自己的路由通道，relay 死活
// 与投递无关（「独立」的定义）。本模块是 relay 进程内的外发腿：
//   · patrol 升级（DL-P1-5：巡检全红 3.5 天零触达的根治腿）
//   · wakeup 谓词成立/过期兜底（T1 外发通道）
// 同一 pushCloudAlert 也被脚本面（哨兵走 curl 直连）等价复用——协议单源在桥。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** wss://host/cloud → https://host/alert（ws→http）。非云桥形态 URL 返回 null。 */
export function bridgeAlertEndpoint(cloudUrl: string): string | null {
  try {
    const u = new URL(cloudUrl);
    if (u.protocol !== "wss:" && u.protocol !== "ws:") return null;
    return `${u.protocol === "wss:" ? "https" : "http"}://${u.host}/alert`;
  } catch {
    return null;
  }
}

export interface BridgeAlertResult {
  ok: boolean;
  status: number;
  delivered?: boolean;
  error?: string;
}

export interface PushBridgeAlertOptions {
  cloudUrl: string;
  token: string;
  to: string;
  title: string;
  body: string;
  level?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 单目标投递。永不 throw（失败以返回值承载——外发腿尽力而为不炸调用方）。 */
export async function pushBridgeAlert(opts: PushBridgeAlertOptions): Promise<BridgeAlertResult> {
  const ep = bridgeAlertEndpoint(opts.cloudUrl);
  if (!ep) return { ok: false, status: 0, error: `bad cloudUrl: ${opts.cloudUrl}` };
  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await doFetch(ep, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ to: opts.to, title: opts.title, body: opts.body, level: opts.level ?? "warn" }),
      signal: ac.signal,
    });
    let payload: { ok?: boolean; delivered?: boolean; error?: string } = {};
    try { payload = (await res.json()) as typeof payload; } catch { /* 非 JSON 回执按空 */ }
    return { ok: res.ok && payload.ok !== false, status: res.status, delivered: payload.delivered, error: payload.error };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 已配对手机 dev 列表（cloud-peers.json 的 ph-* 条目，最近活跃优先）。
 * env CCR_PUSH_TO 优先（逗号分隔多 dev）；无配对=空数组（调用方自记「无触达目标」）。 */
export function pairedPhoneDevs(dataDir: string): string[] {
  const envTo = (process.env.CCR_PUSH_TO ?? "").trim();
  if (envTo) return envTo.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const f = join(dataDir, "cloud-peers.json");
    if (!existsSync(f)) return [];
    const peers = JSON.parse(readFileSync(f, "utf-8")) as Record<string, { last_seen?: number }>;
    return Object.entries(peers)
      .filter(([dev, v]) => dev.startsWith("ph-") && v && typeof v === "object")
      .sort((a, b) => (b[1].last_seen ?? 0) - (a[1].last_seen ?? 0))
      .map(([dev]) => dev);
  } catch {
    return [];
  }
}

export interface CloudPushContext {
  cloudUrl: string;
  cloudToken: string;
  dataDir: string;
}

export interface CloudPushReport {
  title: string;
  body: string;
  level?: string;
  results: BridgeAlertResult[];
  targets: string[];
}

/** 群发到全部已配对手机（逐个投递，互不影响）。永不 throw。 */
export async function pushCloudAlertAll(
  ctx: CloudPushContext,
  title: string,
  body: string,
  level?: string,
  fetchImpl?: typeof fetch,
): Promise<CloudPushReport> {
  const targets = pairedPhoneDevs(ctx.dataDir);
  const results: BridgeAlertResult[] = [];
  for (const to of targets) {
    results.push(await pushBridgeAlert({ cloudUrl: ctx.cloudUrl, token: ctx.cloudToken, to, title, body, level, fetchImpl }));
  }
  return { title, body, level, results, targets };
}
