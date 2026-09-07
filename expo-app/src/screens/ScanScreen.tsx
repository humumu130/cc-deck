// 扫码直连（#276）：全屏相机扫 PC 终端上 relay --qr 打出的「App 直连」码，
// 解析 JSON {v:1,url,token} 自动填入设置表单。权限照语音输入的 PermissionsAndroid
// 模式容错（拒绝/异常都降级为提示文案，不崩不阻塞）；网页端跳过原生申请走浏览器弹窗
import { useEffect, useRef, useState } from "react";
import { Modal, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, Vibration, View } from "react-native";
import { CameraView, type BarcodeScanningResult } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { withA, type ThemeColors } from "../theme";

export interface ScanResult {
  wsUrl: string;
  token: string;
  // #325 扫码登录（微信式）：网页/exe 端出示的授权请求——不是添加服务器，
  // 消费方应发 COMMAND_LOGIN_GRANT 给当前活动 relay
  login?: { dev: string; pk: string; name: string; rd?: string };
}

// 解析扫码内容：v1 JSON（relay 出码）为主，兼容裸 ws(s) 地址带 ?token= 的形式；
// t=ccdeck-login 是网页端扫码登录会话（#325），走 login 分支
export function parseScanPayload(raw: string): ScanResult | null {
  const s = raw.trim();
  try {
    const j = JSON.parse(s) as {
      v?: number; url?: unknown; token?: unknown;
      t?: unknown; dev?: unknown; pk?: unknown; name?: unknown; rd?: unknown;
    };
    if (j?.t === "ccdeck-login") {
      const dev = typeof j.dev === "string" ? j.dev : "";
      const pk = typeof j.pk === "string" ? j.pk : "";
      if (/^wb-[0-9a-f]{6,64}$/.test(dev) && /^[A-Za-z0-9+/=]{40,200}$/.test(pk)) {
        const rd = typeof j.rd === "string" ? j.rd : "";
        return { wsUrl: "", token: "", login: { dev, pk, name: typeof j.name === "string" ? j.name : "浏览器", rd: rd || undefined } };
      }
      return null;
    }
    const url = typeof j?.url === "string" ? j.url : "";
    const token = typeof j?.token === "string" ? j.token : "";
    if (url && token && /^wss?:\/\//.test(url)) {
      return { wsUrl: url.replace(/\/+$/, ""), token };
    }
  } catch {}
  if (/^wss?:\/\/.+\?token=[^&]+/.test(s)) {
    const q = s.indexOf("?");
    return { wsUrl: s.slice(0, q).replace(/\/+$/, ""), token: new URL(s).searchParams.get("token") ?? "" };
  }
  return null;
}

export default function ScanScreen({
  visible,
  onClose,
  onResult,
}: {
  visible: boolean;
  onClose: () => void;
  onResult: (r: ScanResult) => void;
}) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [perm, setPerm] = useState<"asking" | "ok" | "no">("asking");
  const [badCode, setBadCode] = useState(false);
  // 单码去抖：识别成功即关页；扫到非连接码提示期间也忽略后续回调，窗口过后放行重扫
  const lockRef = useRef(false);

  // 每次打开重置状态并申请相机权限（容错：拒绝/异常 → 文案页，可重试）
  useEffect(() => {
    if (!visible) return;
    setPerm("asking");
    setBadCode(false);
    lockRef.current = false;
    if (Platform.OS !== "android") {
      setPerm("ok"); // 网页端由浏览器自行弹权限
      return;
    }
    void (async () => {
      try {
        const res = await PermissionsAndroid.request("android.permission.CAMERA");
        setPerm(res === PermissionsAndroid.RESULTS.GRANTED ? "ok" : "no");
      } catch {
        setPerm("no");
      }
    })();
  }, [visible]);

  const onScan = (ev: BarcodeScanningResult) => {
    if (lockRef.current) return;
    lockRef.current = true;
    const r = parseScanPayload(ev.data);
    if (r) {
      try { Vibration.vibrate(15); } catch {}
      onClose();
      onResult(r);
      return;
    }
    setBadCode(true);
    setTimeout(() => {
      setBadCode(false);
      lockRef.current = false;
    }, 1600);
  };

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={d.root}>
        {perm === "ok" ? (
          <CameraView
            style={d.cam}
            facing="back"
            onBarcodeScanned={onScan}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          />
        ) : null}

        {/* 顶栏：✕ 关闭 + 标题 */}
        <View style={[d.top, { paddingTop: 10 + insets.top }]}>
          <Pressable style={d.closeBtn} hitSlop={10} onPress={onClose} accessibilityLabel="关闭扫码">
            <Text style={d.closeT}>✕</Text>
          </Pressable>
          <Text style={d.topT}>扫码添加服务器</Text>
        </View>

        {perm === "ok" ? (
          <>
            {/* 取景框：细边 + 四角品牌色亮角，克制不动效 */}
            <View style={d.frameLayer} pointerEvents="none">
              <View style={d.frame}>
                <View style={[d.corner, d.cornerTL]} />
                <View style={[d.corner, d.cornerTR]} />
                <View style={[d.corner, d.cornerBL]} />
                <View style={[d.corner, d.cornerBR]} />
              </View>
            </View>
            <View style={[d.hintWrap, { bottom: 40 + insets.bottom }]} pointerEvents="none">
              <Text style={d.hintT}>
                {badCode ? "不是 CC Deck 的连接码或登录码" : "对准 PC 终端「App 直连」码或网页端「扫码登录」码"}
              </Text>
              <Text style={d.hintSubT}>PC 上运行 /cc-deck 出码，网页端在设置里出登录码</Text>
            </View>
          </>
        ) : (
          <View style={d.permLayer}>
            <Text style={d.permT}>
              {perm === "asking" ? "正在申请相机权限…" : "需要相机权限才能扫码"}
            </Text>
            {perm === "no" ? (
              <Pressable style={d.permRetry} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => setPerm("asking")}>
                <Text style={d.permRetryT}>重试</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
    </Modal>
  );
}

const FILL = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 } as const;

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: "#050608" },
  cam: { ...FILL },
  top: {
    position: "absolute", top: 0, left: 0, right: 0,
    flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16,
  },
  closeBtn: {
    width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(5,6,8,0.55)", borderWidth: 1, borderColor: "rgba(255,255,255,0.14)",
  },
  closeT: { color: "#fff", fontSize: 15 },
  topT: { color: "#fff", fontSize: 15, fontWeight: "700" },
  frameLayer: { ...FILL, alignItems: "center", justifyContent: "center" },
  frame: {
    width: 224, height: 224, borderWidth: 1, borderColor: "rgba(255,255,255,0.22)", borderRadius: 18,
  },
  corner: {
    position: "absolute", width: 30, height: 30, borderColor: withA(c.brandA, 0.9),
  },
  cornerTL: { top: -2, left: -2, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 18 },
  cornerTR: { top: -2, right: -2, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 18 },
  cornerBL: { bottom: -2, left: -2, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 18 },
  cornerBR: { bottom: -2, right: -2, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 18 },
  hintWrap: { position: "absolute", left: 0, right: 0, alignItems: "center", gap: 5 },
  hintT: { color: "#fff", fontSize: 13.5, textAlign: "center" },
  hintSubT: { color: "rgba(255,255,255,0.5)", fontSize: 11.5 },
  permLayer: { ...FILL, alignItems: "center", justifyContent: "center", gap: 16, backgroundColor: "#050608" },
  permT: { color: c.dim, fontSize: 13.5 },
  permRetry: {
    paddingHorizontal: 22, paddingVertical: 8, borderRadius: 18,
    backgroundColor: c.tintStrong, borderWidth: 1, borderColor: withA(c.brandA, 0.45),
  },
  permRetryT: { color: c.brandA, fontSize: 13, fontWeight: "700" },
});
