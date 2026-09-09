// 扫码（#276 起逐码演进）：全屏相机扫电脑端出的各种 CC Deck 码，parseScanPayload
// 统一解析分发，routeScanResult 统一路由执行——设置页（表单语境）与设置抽屉（全局
// 语境）共用同一条链路。权限照语音输入的 PermissionsAndroid 模式容错（拒绝/异常都
// 降级为提示文案，不崩不阻塞）；网页端跳过原生申请走浏览器弹窗
import { useEffect, useRef, useState } from "react";
import { Alert, Modal, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, Vibration, View } from "react-native";
import { CameraView, type BarcodeScanningResult } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, useThemeStyles } from "../theme-context";
import { withA, type ThemeColors } from "../theme";
import { store, type ServerEntry } from "../store";
import { uuid } from "../fmt";
import type { ImportTarget } from "./ImportPicker";

export interface ScanResult {
  wsUrl: string;
  token: string;
  // #325 扫码登录（微信式）：网页/exe 端出示的授权请求——不是添加服务器，
  // 消费方应发 COMMAND_LOGIN_GRANT 给当前活动 relay
  login?: { dev: string; pk: string; name: string; rd?: string };
  // #330 云源接入邀请（电脑端「添加手机」出的码）：一次性配对码+桥地址+relay 身份，
  // 消费方走 pair_req 流程落成云源条目
  invite?: { bridge: string; bt: string; rd: string; rk: string; code: string };
  // 连接导入请求（电脑端「分享连接」出的码）：方向反转——手机是连接数据源，rt 是
  // 电脑端临时收件 WebSocket，消费方经 routeScanResult 弹连接选择器（ImportPicker）
  // 把本地连接回传给电脑；临时通道用完即断，不进手机连接列表
  import?: ImportTarget;
}

// 解析扫码内容：v1 JSON（relay 出码）为主，兼容裸 ws(s) 地址带 ?token= 的形式；
// t=ccdeck-login 是网页端扫码登录会话（#325）走 login 分支；t=ccdeck-add 是
// 电脑端「添加手机」出的一次性接入码（#330）走 invite 分支（电脑端「分享连接」
// 出的码同构，天然同分支兼容）；t=ccdeck-import 是电脑端请求导入手机连接（手机侧
// 反向出数据）走 import 分支
export function parseScanPayload(raw: string): ScanResult | null {
  const s = raw.trim();
  try {
    const j = JSON.parse(s) as {
      v?: number; url?: unknown; token?: unknown;
      t?: unknown; dev?: unknown; pk?: unknown; name?: unknown; rd?: unknown;
      bridge?: unknown; bt?: unknown; rk?: unknown; code?: unknown;
      rt?: unknown;
    };
    if (j?.t === "ccdeck-login") {
      const dev = typeof j.dev === "string" ? j.dev : "";
      const pk = typeof j.pk === "string" ? j.pk : "";
      if (/^wb-[0-9a-f]{6,64}$/.test(dev) && /^[A-Za-z0-9+/=]{40,200}$/.test(pk)) {
        const rd = typeof j.rd === "string" ? j.rd : "";
        // #383 网页端 QR 库不编码 UTF-8：name 是 encodeURIComponent 过的，这里解码
        let name = "浏览器";
        if (typeof j.name === "string" && j.name) {
          try { name = decodeURIComponent(j.name); } catch { name = j.name; }
        }
        return { wsUrl: "", token: "", login: { dev, pk, name, rd: rd || undefined } };
      }
      return null;
    }
    if (j?.t === "ccdeck-add") {
      const bridge = typeof j.bridge === "string" ? j.bridge.replace(/\/+$/, "") : "";
      const bt = typeof j.bt === "string" ? j.bt : "";
      const rd = typeof j.rd === "string" ? j.rd : "";
      const rk = typeof j.rk === "string" ? j.rk : "";
      const code = typeof j.code === "string" ? j.code : "";
      if (/^wss?:\/\//.test(bridge) && rd.startsWith("rl-") && rk && /^\d{6}$/.test(code)) {
        return { wsUrl: "", token: "", invite: { bridge, bt, rd, rk, code } };
      }
      return null;
    }
    if (j?.t === "ccdeck-import") {
      // rt = 电脑端临时收件通道：url 须是 ws(s)://、token 非空才可信
      const rt = (typeof j.rt === "object" && j.rt !== null ? j.rt : {}) as {
        url?: unknown; token?: unknown;
      };
      const ru = typeof rt.url === "string" ? rt.url.replace(/\/+$/, "") : "";
      const rtk = typeof rt.token === "string" ? rt.token : "";
      if (/^wss?:\/\//.test(ru) && rtk) {
        return { wsUrl: "", token: "", import: { url: ru, token: rtk } };
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

// ---------- 扫码结果统一路由（#325/#330/#40 逐码演进后收敛为一个入口） ----------
// 设置页（表单语境）与设置抽屉（全局语境）共用：消费方只注入文案出口/收尾钩子，
// 四种码的分发与执行只有这一份实现，不再两地各写一份互相漂移

export interface ScanRouteCtx {
  // 失败/引导文案出口：设置页=表单 err 行；抽屉=Alert 弹窗
  onError: (msg: string) => void;
  // 接入/连接落库成功后的收尾（设置页=刷新列表+关页；抽屉=刷新列表）
  onDone?: () => void;
  // import 码消费：挂载方拉起连接选择器（ImportPicker 完成选定+回发）
  onImport: (t: ImportTarget) => void;
  // 直连码表单回填钩子（仅设置页需要表单同步，连接失败停留本页时不误导；缺省跳过）。
  // 返回值=新条目采用的显示名（表单已手输名称则尊重；空/缺省回落 host）
  onDirect?: (base: string, token: string) => string | undefined;
}

function hostOf(wsUrl: string): string {
  try {
    return new URL(wsUrl).host;
  } catch {
    return wsUrl;
  }
}

export async function routeScanResult(r: ScanResult, ctx: ScanRouteCtx): Promise<void> {
  const servers = await store.loadServers();
  // ccdeck-login = 网页端出示的登录码——扫码即登录，手机不要求预先连接/切换到对应
  // 服务器：授权优先发给 relayDev 与码中 rd 匹配的已连接源（多服务器下不串台），
  // 没有匹配则走活动源（手机是信任锚，网页端 pair_ack 的密封本身即身份证明）
  if (r.login) {
    const { dev, pk, rd } = r.login;
    const who = r.login.name.length > 16 ? `${r.login.name.slice(0, 16)}…` : r.login.name;
    const viaId = rd ? store.sourceIdForRelay(rd) : undefined;
    const activeId = await store.activeServerId();
    const viaName = (viaId ? servers.find((e) => e.id === viaId) : servers.find((e) => e.id === activeId))?.name;
    Alert.alert(
      "扫码登录",
      `允许「${who}」接入${viaName ? `「${viaName}」` : "这台服务器"}？\n授权后它可查看会话并发送指令。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "允许",
          onPress: () => {
            if (!store.send("COMMAND_LOGIN_GRANT", { session_dev: dev, session_pk: pk, name: who }, viaId)) {
              ctx.onError("未连接 relay：先连接服务器，再扫码授权网页端");
            }
          },
        },
      ],
      { cancelable: true },
    );
    return;
  }
  // ccdeck-add = 云源接入邀请（#330，电脑端「分享连接」出的码同构兼容）：确认后
  // pair_req 落库自动连接
  if (r.invite) {
    const inv = r.invite;
    Alert.alert(
      "接入云服务器",
      `扫码接入「${hostOf(inv.bridge)}」？\n将使用一次性配对码自动完成。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "接入",
          onPress: () => {
            void store.addCloudByInvite(inv).then((err) => {
              if (err) ctx.onError(err);
              else ctx.onDone?.();
            });
          },
        },
      ],
      { cancelable: true },
    );
    return;
  }
  // ccdeck-import = 电脑端请求导入手机连接：弹连接选择器由用户挑一条回发
  if (r.import) {
    ctx.onImport(r.import);
    return;
  }
  // 直连码即扫即连：码里已含完整 url+token，直接建/复用条目连接
  //（此前回填表单让用户手点「连接」，多一步且易漏）
  const base = r.wsUrl.replace(/\/+$/, "");
  const named = ctx.onDirect?.(base, r.token);
  const dup = servers.find((e) => e.wsUrl === base);
  const entry: ServerEntry = dup
    ? { ...dup, token: r.token }
    : { id: uuid(), name: (named && named.trim()) || hostOf(base), wsUrl: base, token: r.token };
  void store.connectServer(entry, r.token).then(() => ctx.onDone?.());
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
          <Text style={d.topT}>扫码连接</Text>
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
                {badCode ? "不是 CC Deck 的连接码" : "对准电脑端出的 CC Deck 码（直连 / 登录 / 导入）"}
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
