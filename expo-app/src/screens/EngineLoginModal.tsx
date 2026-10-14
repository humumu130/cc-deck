// #102 批 B 引擎登录引导卡（把饭喂到嘴里——用户 1014 定调）：
// relay 登录 pane（tmux 托管）提取授权 URL → AUTH_REQUIRED 瞬态帧 → 本卡渲染
// 二维码，扫码即登录，全程零终端操作。三端同构契约（relay types.ts
// AuthRequiredPayload / web __ccDeck005LoginCard）。
//
// 形态分派（mode）：
//   qr      URL 渲染二维码（codebuddy device-flow/trae enterprise——任意设备扫码授权）
//   browser 本机浏览器回调型（codex：CLI 自开 Mac 浏览器；手机端提示回 Mac 完成）
//   hint    纯指引降级（无 profile 引擎兜底）
// QR 矩阵：vendor qr.ts（与 web-console/qr.js 同源，MIT）→ react-native-svg Rect 网格。
import { useEffect, useMemo, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, Text, View } from "react-native";
import Svg, { Rect } from "react-native-svg";
import { QRCode, QRErrorCorrectLevel } from "../qr";
import { useTheme, useThemeStyles } from "../theme-context";
import { store, useRelay } from "../store";
import type { ThemeColors } from "../theme";

const ENGINE_NAME: Record<string, string> = {
  claude: "Claude", codex: "Codex", trae: "Trae", "qwen-code": "Qwen", codebuddy: "CodeBuddy", zcode: "ZCode",
};

// 授权 URL → QR 矩阵（dark[r][c]；渲染失败 null → 降级链接按钮）
function qrMatrix(text: string): boolean[][] | null {
  try {
    const q = new (QRCode as unknown as new (typeNumber: number, level: number) => {
      addData(v: string): void;
      make(): void;
      getModuleCount(): number;
      isDark(r: number, c: number): boolean;
    })(0, QRErrorCorrectLevel.M);
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const rows: boolean[][] = [];
    for (let r = 0; r < n; r++) rows.push(Array.from({ length: n }, (_, c) => q.isDark(r, c)));
    return rows;
  } catch {
    return null;
  }
}

function makeStyles(c: ThemeColors) {
  return {
    mask: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", alignItems: "center", padding: 22 } as const,
    card: { width: "100%", maxWidth: 360, borderRadius: 16, backgroundColor: c.panel, padding: 16 } as const,
    title: { fontSize: 17, fontWeight: "700", color: c.text, marginBottom: 2 } as const,
    stateT: { fontSize: 12, color: c.faint, marginBottom: 10 } as const,
    qrWrap: { alignItems: "center", backgroundColor: "#fff", borderRadius: 10, padding: 10, marginBottom: 10 } as const,
    hintT: { fontSize: 13, color: c.dim, lineHeight: 19, marginBottom: 10 } as const,
    linkBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.hover, marginBottom: 10 } as const,
    linkT: { fontSize: 13, color: c.brandA, textAlign: "center" } as const,
    btns: { flexDirection: "row", gap: 10 } as const,
    btnPrimary: { flex: 1, paddingVertical: 11, borderRadius: 10, backgroundColor: c.brandA, alignItems: "center" } as const,
    btnGhost: { flex: 1, paddingVertical: 11, borderRadius: 10, backgroundColor: c.hover, alignItems: "center" } as const,
    btnPrimaryT: { fontSize: 14, color: "#fff", fontWeight: "600" } as const,
    btnGhostT: { fontSize: 14, color: c.text } as const,
    readyT: { fontSize: 13, color: c.done, lineHeight: 19, marginBottom: 10 } as const,
  };
}

export default function EngineLoginModal() {
  const { c } = useTheme();
  const m = useThemeStyles(makeStyles);
  const snap = useRelay();
  const flow = snap.authFlow;
  // 终态收卡（ready 2.2s 自动收/用户手收）：本地 dismissed 不写 store（重连快照
  // 清 authFlow 是权威收卡面；新流程 flow_id 变化自动重置 dismissed 再弹）
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    if (flow && flow.flow_id !== dismissed) return;
    if (flow && flow.state !== "pending" && flow.state !== "starting") setVerifying(false);
  }, [flow, dismissed]);
  useEffect(() => {
    if (flow?.state === "ready" && flow.flow_id !== dismissed) {
      const t = setTimeout(() => setDismissed(flow.flow_id), 2200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [flow, dismissed]);
  const visible = !!flow && flow.flow_id !== dismissed;
  const matrix = useMemo(() => (visible && flow?.mode === "qr" && flow.url ? qrMatrix(flow.url) : null), [visible, flow?.mode, flow?.url]);
  if (!flow || !visible) return null;
  const name = ENGINE_NAME[flow.engine] || flow.engine;
  const stateText =
    flow.state === "ready" ? "已登录" :
    flow.state === "starting" ? "拉起登录面板…" :
    flow.state === "timeout" ? "等待超时" :
    flow.state === "error" ? "拉起失败" :
    flow.state === "cancelled" ? "已取消" :
    verifying ? "验证中…" : "等待登录";
  const openUrl = flow.url ? () => { void Linking.openURL(flow.url!).catch(() => undefined); } : null;

  let body: React.ReactNode = null;
  if (flow.state === "ready") {
    body = (
      <Text style={m.readyT}>{name} 已登录，引擎目录已点亮，现在可以用它创建会话了。</Text>
    );
  } else if (flow.state === "timeout" || flow.state === "error" || flow.state === "cancelled") {
    body = <Text style={m.hintT}>{flow.hint || "登录未完成"}</Text>;
  } else if (flow.mode === "qr" && matrix) {
    body = (
      <>
        <View style={m.qrWrap}>
          <Svg width={188} height={188}>
            <Rect x={0} y={0} width={188} height={188} fill="#fff" />
            {matrix.map((row, r) =>
              row.map((dark, col) =>
                dark ? <Rect key={`${r}-${col}`} x={4 + col * 6} y={4 + r * 6} width={6} height={6} fill="#10151C" /> : null,
              ),
            )}
          </Svg>
        </View>
        <Text style={m.hintT}>手机扫不了自己的屏：截图后用微信「扫一扫」选相册识别，或点下方按钮跳系统浏览器完成授权。</Text>
        {openUrl ? (
          <Pressable style={m.linkBtn} accessibilityRole="button" accessibilityLabel="在浏览器打开授权页" onPress={openUrl}>
            <Text style={m.linkT}>在浏览器打开授权页</Text>
          </Pressable>
        ) : null}
      </>
    );
  } else if (flow.mode === "qr" && flow.qr_text) {
    body = (
      <>
        <ScrollView style={{ maxHeight: 160, backgroundColor: "#fff", borderRadius: 10, marginBottom: 10 }}>
          <Text style={{ fontFamily: "monospace", fontSize: 6, lineHeight: 7, color: "#10151C" }}>{flow.qr_text}</Text>
        </ScrollView>
        {openUrl ? (
          <Pressable style={m.linkBtn} accessibilityRole="button" onPress={openUrl}>
            <Text style={m.linkT}>在浏览器打开授权页</Text>
          </Pressable>
        ) : null}
      </>
    );
  } else if (flow.mode === "browser") {
    body = (
      <>
        <Text style={m.hintT}>已在这台电脑（Mac）上为你打开浏览器完成授权；请在电脑前完成登录。</Text>
        {openUrl ? (
          <Pressable style={m.linkBtn} accessibilityRole="button" onPress={openUrl}>
            <Text style={m.linkT}>浏览器没打开？点此手动打开授权页</Text>
          </Pressable>
        ) : null}
      </>
    );
  } else {
    body = <Text style={m.hintT}>{flow.hint || "请完成引擎登录"}</Text>;
  }

  const busy = flow.state === "starting" || verifying;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => setDismissed(flow.flow_id)}>
      <View style={m.mask}>
        <View style={m.card}>
          <Text style={m.title}>🔑 {name} 登录</Text>
          <Text style={m.stateT}>{stateText}</Text>
          {body}
          <View style={m.btns}>
            {flow.state === "ready" ? (
              <Pressable style={m.btnPrimary} accessibilityRole="button" onPress={() => setDismissed(flow.flow_id)}>
                <Text style={m.btnPrimaryT}>好</Text>
              </Pressable>
            ) : flow.state === "timeout" || flow.state === "error" || flow.state === "cancelled" ? (
              <>
                <Pressable
                  style={m.btnPrimary}
                  accessibilityRole="button"
                  onPress={() => {
                    setVerifying(false);
                    store.engineLogin(flow.engine, "start");
                  }}
                >
                  <Text style={m.btnPrimaryT}>重新发起</Text>
                </Pressable>
                <Pressable style={m.btnGhost} accessibilityRole="button" onPress={() => setDismissed(flow.flow_id)}>
                  <Text style={m.btnGhostT}>关闭</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  style={m.btnPrimary}
                  accessibilityRole="button"
                  disabled={busy}
                  accessibilityLabel="我已完成登录"
                  onPress={() => {
                    setVerifying(true);
                    store.engineLogin(flow.engine, "verify");
                  }}
                >
                  <Text style={m.btnPrimaryT}>{verifying ? "验证中…" : "我已完成登录"}</Text>
                </Pressable>
                <Pressable
                  style={m.btnGhost}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => {
                    store.engineLogin(flow.engine, "cancel");
                    setDismissed(flow.flow_id);
                  }}
                >
                  <Text style={m.btnGhostT}>取消</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}
