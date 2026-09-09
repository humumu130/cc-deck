// 连接导入选择器（ccdeck-import 手机侧）：电脑端「分享连接」码扫入后弹出——列出手机上
// 可分享的连接（有令牌或云桥配置的条目；行首点亮绿=该源当前在线），点选一条后向码中
// rt 临时 WebSocket 回发 ccdeck-import-resp：
//   LAN 条目  entry={kind:"lan", wsUrl, token}
//   云条目    entry={kind:"cloud", wsUrl, token, cloud:{url, token, rd, rk, paired:true}}
//   已配对云源且在线 → 先向其 relay 领一次性配对码附在 cloud.code（电脑侧免输码直接
//   pair）；该源离线 → 省略 code，resp.note="未在线，未附码"
// 临时通道用完即断，绝不进手机连接列表。发送反馈在弹层内呈现（RN Modal 压住全局
// Toast，NewSessionModal 同款教训），成功后短暂停留再自动收层
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { store, useRelay, type ServerEntry } from "../store";

// 回传目标两形态：
//   LAN rt（旧）：电脑端临时收件通道（码中 rt 字段）——url + 一次性收件令牌，同一 WiFi
//   cloudPush（0.4.4 合并码）：经 relay 加密中转（COMMAND_IMPORT_PUSH，跨网络）——
//     dev/pk = 出码端身份，viaId = 授权源（rd 匹配的已连源，缺省活动源）
export type ImportTarget =
  | { url: string; token: string }
  | { cloudPush: { dev: string; pk: string; viaId?: string } };

type SendState =
  | { phase: "idle" }
  | { phase: "busy"; text: string }
  | { phase: "ok"; text: string }
  | { phase: "fail"; text: string };

// 条目可分享的令牌：优先落库令牌；勾了「不记住令牌」但当前在线的条目回落本次建连
// 实际用的令牌（store 建连参数快照），避免明明连着却分享不出一条能用的连接
function shareTokenOf(e: ServerEntry): string {
  return e.token || store.sourceInfoOf(e.id)?.token || "";
}

// 向指定源领取一次性配对码（电脑侧 pair 用）：复用 COMMAND_PAIR_CODE 命令链路——
// store.send 已按 sourceId 路由并做 ACK 重发，配对码经 store 快照 pairCode 透出，
// 这里订阅比对（发码前记旧值，出现新的 pairCode 即领取成功），~7s 无果视为失败
// （源掉线时 send 直接返回 false）。纯组件层实现，不动 store 连接层（#40 刚改完）
function fetchPairCode(sourceId: string): Promise<string | null> {
  const before = store.getSnapshot().pairCode;
  if (!store.send("COMMAND_PAIR_CODE", {}, sourceId)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const fin = (v: string | null) => {
      if (done) return;
      done = true;
      unsub();
      clearTimeout(timer);
      resolve(v);
    };
    const unsub = store.subscribe(() => {
      const pc = store.getSnapshot().pairCode;
      if (pc && pc !== before) fin(pc.code);
    });
    const timer = setTimeout(() => fin(null), 7000);
  });
}

// 临时 WebSocket 回发（LAN rt 通道专用；云中转走 pick 内的 COMMAND_IMPORT_PUSH）：
// 8s 内必须完成 open+send；发出后收到任意回帧即算送达并关闭，
// 2s 无回帧也收摊（电脑端处理完即断开属正常）。发出前的 close/error 都算失败
function sendToTarget(rt: { url: string; token: string }, resp: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = rt.url + (rt.url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(rt.token);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      reject(new Error("电脑给出的地址无效"));
      return;
    }
    let settled = false;
    let sent = false;
    let grace: ReturnType<typeof setTimeout> | null = null;
    // 用完即弃：摘掉全部 handlers 再关，防晚到的回调触到已 resolve 的 promise 之外
    const cleanup = () => {
      try { ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null; } catch {}
      try { ws.close(); } catch {}
    };
    const fin = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      if (grace) clearTimeout(grace);
      cleanup();
      if (err) reject(err);
      else resolve();
    };
    const overall = setTimeout(() => fin(new Error(sent ? "电脑未回应" : "连接电脑超时")), 8000);
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(resp));
      } catch {
        fin(new Error("数据发送失败"));
        return;
      }
      sent = true;
      grace = setTimeout(() => fin(null), 2000);
    };
    ws.onmessage = () => fin(null); // 任意回帧 = 电脑已收到
    ws.onerror = () => fin(new Error(sent ? "电脑中断了连接" : "连不上电脑"));
    ws.onclose = () => fin(sent ? null : new Error("电脑拒绝了连接"));
  });
}

function hostOf(wsUrl: string): string {
  try {
    return new URL(wsUrl).host;
  } catch {
    return wsUrl;
  }
}

export default function ImportPicker({
  visible,
  target,
  onClose,
}: {
  visible: boolean;
  target: ImportTarget | null;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const m = useThemeStyles(makeStyles);
  const snap = useRelay();
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [st, setSt] = useState<SendState>({ phase: "idle" });
  const aliveRef = useRef(false);
  const busyRef = useRef(false);

  // 每次打开重读条目（自上次打开可能已增删/改配对）并复位状态；收起后到达的回调
  // 一律不落 state（防卸载/收层后写入）
  useEffect(() => {
    if (!visible) {
      aliveRef.current = false;
      return;
    }
    aliveRef.current = true;
    busyRef.current = false;
    setSt({ phase: "idle" });
    void store.loadServers().then((list) => {
      if (aliveRef.current) setServers(list);
    });
    return () => {
      aliveRef.current = false;
    };
  }, [visible]);

  const stateOf = new Map(snap.sources.map((x) => [x.id, x.state] as const));
  const shareable = servers.filter((e) => !!shareTokenOf(e) || !!e.cloud);

  const pick = (e: ServerEntry) => {
    if (busyRef.current || !target) return;
    busyRef.current = true;
    const setLive = (s: SendState) => {
      if (aliveRef.current) setSt(s);
    };
    void (async () => {
      try {
        const online = stateOf.get(e.id) === "online";
        let entry: Record<string, unknown>;
        let note: string | null = null;
        if (e.cloud) {
          entry = {
            kind: "cloud",
            wsUrl: e.wsUrl,
            token: shareTokenOf(e),
            cloud: {
              url: e.cloud.url,
              token: e.cloud.token,
              rd: e.cloud.relayDev,
              rk: e.cloud.relayPubkey,
              paired: true, // 有 cloud 配置 = 已配对（配置本身即配对产物）
            },
          };
          if (online) {
            setLive({ phase: "busy", text: "正在向该服务器领取一次性配对码…" });
            const code = await fetchPairCode(e.id);
            if (code) (entry.cloud as Record<string, unknown>).code = code;
            else note = "领码超时，未附码";
          } else {
            note = "未在线，未附码";
          }
        } else {
          entry = { kind: "lan", wsUrl: e.wsUrl, token: shareTokenOf(e) };
        }
        setLive({ phase: "busy", text: "正在发送给电脑…" });
        if ("cloudPush" in target) {
          // 0.4.4 云中转：relay 校验后用出码端公钥密封投递（跨网络）。ACK 带结果
          // 语义（离线/格式等同步报错）；断连清场不回调，15s 兜底收摊
          const cp = target.cloudPush;
          const sent = await new Promise<{ ok: boolean; err: string | null }>((resolve) => {
            let done = false;
            const fin = (r: { ok: boolean; err: string | null }) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve(r);
            };
            const timer = setTimeout(() => fin({ ok: false, err: "等待服务器确认超时" }), 15000);
            const queued = store.send(
              "COMMAND_IMPORT_PUSH",
              { target_dev: cp.dev, target_pk: cp.pk, entry, ...(note ? { note } : {}) },
              cp.viaId,
              (r) => fin(r),
            );
            if (!queued) fin({ ok: false, err: "未连接，未发送" });
          });
          if (!sent.ok) throw new Error(sent.err ?? "未知错误");
        } else {
          const resp: Record<string, unknown> = { t: "ccdeck-import-resp", entry };
          if (note) resp.note = note;
          await sendToTarget(target, resp);
        }
        setLive({ phase: "ok", text: note ? `已发送给电脑（${note}）` : "已发送给电脑" });
        setTimeout(() => {
          if (aliveRef.current) onClose();
        }, 1400);
      } catch (e2) {
        setLive({ phase: "fail", text: `发送失败：${e2 instanceof Error ? e2.message : String(e2)}` });
      } finally {
        busyRef.current = false;
      }
    })();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={m.mask} onPress={busyRef.current ? undefined : onClose}>
        <View style={{ width: "100%" }}>
          <Pressable style={m.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={m.h3}>分享连接给电脑</Text>
            <Text style={m.sub}>
              {target && "url" in target
                ? `电脑 ${hostOf(target.url)} `
                : target
                  ? "电脑经服务器中转接收（跨网络可用）"
                  : "电脑 "}
              请求导入手机上的连接，点选要分享的一条
            </Text>
            {shareable.length === 0 ? (
              <View style={m.empty}>
                <Text style={m.emptyT}>手机上还没有可分享的连接</Text>
                <Text style={m.emptySubT}>先在「设置」里添加并连接服务器，再扫码分享</Text>
              </View>
            ) : (
              <ScrollView style={m.list} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                {shareable.map((e) => {
                  const online = stateOf.get(e.id) === "online";
                  return (
                    <Pressable
                      key={e.id}
                      style={m.row}
                      android_ripple={{ color: c.tintSoft, borderless: false }}
                      disabled={busyRef.current}
                      onPress={() => pick(e)}
                      accessibilityLabel={`分享 ${e.name}`}
                    >
                      <View style={[m.rowDot, { backgroundColor: online ? c.done : c.faint }]} />
                      <View style={m.rowMain}>
                        <View style={m.rowHead}>
                          <Text style={m.rowName} numberOfLines={1}>{e.name}</Text>
                          {e.cloud ? (
                            <Text style={m.badgeCloud}>云桥 · 已配对</Text>
                          ) : (
                            <Text style={m.badgeLan}>直连</Text>
                          )}
                        </View>
                        <Text style={m.rowUrl} numberOfLines={1}>{e.wsUrl}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
            {st.phase !== "idle" ? (
              <Text
                style={st.phase === "ok" ? m.okT : st.phase === "fail" ? m.failT : m.busyT}
                numberOfLines={2}
              >
                {st.text}
              </Text>
            ) : null}
            <Pressable style={m.cancel} android_ripple={{ color: c.tintSoft, borderless: false, radius: 21 }} disabled={busyRef.current} onPress={onClose}>
              <Text style={m.cancelT}>{st.phase === "fail" ? "关闭" : "取消"}</Text>
            </Pressable>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  // 贴底弹层：NewSessionModal / 关于弹窗同款视觉语言（mask+上圆角 sheet）
  mask: { flex: 1, backgroundColor: withA("#02050A", 0.65), justifyContent: "flex-end" },
  sheet: {
    backgroundColor: c.panel, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderTopColor: c.line, paddingHorizontal: 16,
    paddingTop: 18, paddingBottom: 30,
  },
  h3: { color: c.text, fontSize: 16, fontWeight: "700", marginBottom: 4 },
  sub: { color: c.faint, fontSize: 12, marginBottom: 12 },
  list: { maxHeight: 328, flexGrow: 0 },
  // 行 = 状态点 + 名称/kind 徽章 + 地址：SetupScreen srvRow 同语言（圆角 12/细边框/panel2 底）
  row: {
    flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 11,
    paddingVertical: 10, borderWidth: 1, borderColor: c.line, borderRadius: 12,
    backgroundColor: c.panel2, marginBottom: 8, overflow: "hidden",
  },
  rowDot: { width: 7, height: 7, borderRadius: 4 },
  rowMain: { flex: 1, minWidth: 0 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowName: { color: c.text, fontSize: 13.5, fontWeight: "600", flexShrink: 1 },
  // kind 徽章：云桥（已配对）=绿对齐 SetupScreen「已配对 ✓」语义；直连=灰
  badgeCloud: { color: c.done, fontSize: 10, fontWeight: "700" },
  badgeLan: { color: c.faint, fontSize: 10, fontWeight: "600" },
  rowUrl: { color: c.faint, fontSize: 10.5, marginTop: 1.5 },
  empty: { alignItems: "center", paddingVertical: 22, gap: 5 },
  emptyT: { color: c.dim, fontSize: 13.5, fontWeight: "600" },
  emptySubT: { color: c.faint, fontSize: 11.5 },
  busyT: { color: c.dim, fontSize: 12.5, marginTop: 6 },
  okT: { color: c.done, fontSize: 12.5, fontWeight: "700", marginTop: 6 },
  failT: { color: c.waiting, fontSize: 12.5, marginTop: 6 },
  cancel: { height: 42, marginTop: 8, alignItems: "center", justifyContent: "center" },
  cancelT: { color: c.dim, fontSize: 14 },
});
