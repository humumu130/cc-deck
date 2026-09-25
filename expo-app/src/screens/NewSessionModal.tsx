import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { store, useRelay } from "../store";

// 任务模板：点击填入提示词（不自动提交）
const PRESETS: { label: string; text: string }[] = [
  { label: "修复构建", text: "运行构建，分析报错并修复，直到构建通过。" },
  { label: "跑测试", text: "运行测试套件，修复所有失败的测试。" },
  { label: "代码审查", text: "审查最近的改动（git diff），指出问题并给出改进建议。" },
  { label: "继续未完成", text: "查看当前工作状态，继续完成未完成的任务。" },
];

export default function NewSessionModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const m = useThemeStyles(makeStyles);
  const snap = useRelay();
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // 跳过权限确认（2026-09-16 用户需求）：新建时可选 bypass，免逐项审批
  const [bypass, setBypass] = useState(false);
  // #208 目录自动创建开关（用户配置开关）：开=relay 侧按输入路径 mkdir -p（含多级，
  // 时间线说明「已自动创建」）；关（默认）=旧行为回落默认目录并说明。AsyncStorage
  // 记忆偏好（偏好型开关，不像 bypass 语义敏感需要每次显式勾）
  const [autoMkdir, setAutoMkdir] = useState(false);
  const [loadedInit, setLoadedInit] = useState(false);

  // 目标源（#294 批3 + #369 记忆）：聚合且多源时 chips 选发送目标，默认=上次选择
  //（AsyncStorage 跨次记忆，对齐网页端 ccd_new_target），无记忆回落活动源。
  // 单源/未聚合零变化——不渲染选择、不传 sourceId，COMMAND_CREATE 照旧走活动源
  const multi = snap.aggregate && snap.sources.length > 1;
  const [targetId, setTargetId] = useState<string | null>(null);
  const effTarget = multi
    ? targetId && snap.sources.some((x) => x.id === targetId)
      ? targetId
      : snap.activeSourceId ?? snap.sources[0]?.id ?? null
    : null;
  // 目标源 relay 平台（SNAPSHOT.platform，0.5.3 起）：win32 沿用盘符示例；其余按
  // relay 侧路径展示并拦截盘符输入（Windows 客户端填 D:\ 发到 mac relay 会回落
  // 家目录并告警）；旧 relay 无字段 → 旧口径零变化
  const plat = (multi ? snap.sources.find((x) => x.id === effTarget) : null)
    ?? snap.sources.find((x) => x.id === snap.activeSourceId)
    ?? snap.sources[0];
  const relayPlatform = plat?.platform;
  const posixRelay = !!relayPlatform && relayPlatform !== "win32";

  if (visible && !loadedInit) {
    setLoadedInit(true);
    setErr(null);
    setTargetId(null);
    void AsyncStorage.getItem("ccr_cwd").then((v) => v && setCwd(v));
    void AsyncStorage.getItem("ccr_auto_mkdir").then((v) => setAutoMkdir(v === "1"));
    void AsyncStorage.getItem("ccr_new_target").then((v) => {
      if (v && snap.sources.some((x) => x.id === v)) setTargetId(v);
    });
  }
  if (!visible && loadedInit) setLoadedInit(false);

  const create = () => {
    const cc = cwd.trim();
    const p = prompt.trim();
    if (!cc) {
      setErr(`请填写工作目录（${posixRelay ? "relay 侧路径" : "PC 上的项目路径"}）`);
      return;
    }
    // 盘符路径拦截（与网页端同款）：非 win32 relay 上 C:\ 类路径必然无效（会话跑
    // 在 relay 本机，客户端本地盘符无意义），提前拦下省一次创建失败往返
    if (posixRelay && (/^[A-Za-z]:[\\/]?/.test(cc) || /^\/[A-Za-z]:/.test(cc))) {
      setErr(`Windows 盘符路径在当前 relay（${relayPlatform === "darwin" ? "macOS" : relayPlatform}）上无效，请填 relay 侧路径`);
      return;
    }
    setErr(null);
    void AsyncStorage.setItem("ccr_cwd", cc);
    if (store.send("COMMAND_CREATE", { cwd: cc, prompt: "" + p, ...(bypass ? { permissionMode: "bypassPermissions" as const } : {}), ...(autoMkdir ? { autoMkdir: true } : {}) }, multi ? effTarget ?? undefined : undefined)) {
      setPrompt("");
      onClose();
    } else {
      // 失败必须内联报错：全局 Toast 被 RN Modal 原生层压住，store.send 发出的
      // lastErrorCmd 在本弹窗里永远看不见，表现为「点了没反应」
      setErr(multi ? "该源未连接，命令未发送" : "未连接服务器，命令未发送");
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={m.mask} onPress={onClose}>
        {/* Modal 独立窗口 decorFitsSystemWindows=true + adjustResize，原生即可避让键盘 */}
        <View style={{ width: "100%" }}>
          <Pressable style={m.sheet} onPress={(e) => e.stopPropagation()}>            <Text style={m.h3}>新建托管会话</Text>
            {multi ? (
              <View style={m.field}>
                <Text style={m.label}>发送至</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={m.presetRow} contentContainerStyle={{ gap: 7 }}>
                  {snap.sources.map((src) => {
                    const on = src.id === effTarget;
                    const online = src.state === "online";
                    return (
                      <Pressable
                        key={src.id}
                        style={[m.srcChip, on && m.srcChipOn]}
                        android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
                        onPress={() => {
                          setTargetId(src.id);
                          void AsyncStorage.setItem("ccr_new_target", src.id);
                        }}
                      >
                        <View style={[m.srcDot, { backgroundColor: online ? c.done : c.faint }]} />
                        <Text style={[m.srcChipT, on && m.srcChipTOn, !online && !on && { color: c.faint }]} numberOfLines={1}>
                          {src.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
            <View style={m.field}>
              <Text style={m.label}>工作目录（{posixRelay ? "relay 侧路径" : "PC 上的路径"}）</Text>
              <TextInput
                style={[m.input, err && m.inputErr]}
                value={cwd}
                onChangeText={(v) => { setCwd(v); setErr(null); }}
                placeholder={posixRelay ? "~/dev/myproject" : "D:\dev\myproject"}
                placeholderTextColor={c.faint}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
            </View>
            {err ? <Text style={m.errT}>{err}</Text> : null}
            <Pressable style={m.bypassRow} hitSlop={6} onPress={() => setBypass((v) => !v)}>
              <View style={[m.bypassBox, bypass && m.bypassBoxOn]}>
                {bypass ? <Text style={m.bypassCheck}>✓</Text> : null}
              </View>
              <Text style={m.bypassT}>跳过权限确认（工具调用不再逐项审批，慎用）</Text>
            </Pressable>
            {/* #208 目录自动创建：同 checkbox 语言；勾选状态跨次记忆（AsyncStorage） */}
            <Pressable
              style={m.bypassRow}
              hitSlop={6}
              onPress={() =>
                setAutoMkdir((v) => {
                  const next = !v;
                  void AsyncStorage.setItem("ccr_auto_mkdir", next ? "1" : "0");
                  return next;
                })
              }
            >
              <View style={[m.bypassBox, autoMkdir && m.bypassBoxOn]}>
                {autoMkdir ? <Text style={m.bypassCheck}>✓</Text> : null}
              </View>
              <Text style={m.bypassT}>目录不存在时自动创建</Text>
            </Pressable>
            <Pressable style={m.createBtn} android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false }} onPress={create}>
              <Text style={m.createT}>启动会话</Text>
            </Pressable>
            <Pressable style={m.cancel} android_ripple={{ color: c.tintSoft, borderless: false, radius: 22 }} onPress={onClose}>
              <Text style={m.cancelT}>取消</Text>
            </Pressable>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  mask: { flex: 1, backgroundColor: withA("#02050A", 0.65), justifyContent: "flex-end" },
  sheet: {
    backgroundColor: c.panel, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderTopColor: c.line, paddingHorizontal: 16,
    paddingTop: 18, paddingBottom: 30,
  },
  h3: { color: c.text, fontSize: 16, fontWeight: "700", marginBottom: 14 },
  field: { marginBottom: 12 },
  label: { color: c.dim, fontSize: 12, marginBottom: 6 },
  input: {
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, borderRadius: 12,
    paddingHorizontal: 13, paddingVertical: 11, color: c.text, fontSize: 15,
  },
  inputErr: { borderColor: withA(c.waiting, 0.6) },
  errT: { color: c.waiting, fontSize: 12, marginBottom: 10 },
  ta: { minHeight: 88, textAlignVertical: "top" },
  presetRow: { marginBottom: 8, flexGrow: 0 },
  presetChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
  },
  presetT: { fontSize: 12, color: c.dim },
  // 目标源 chip（#294 批3）：presetChip 同形态 + 状态点（在线绿/离线灰），选中态同
  // chip 语言（品牌染底/描边）；离线源可选，发送时报"未连接"由全局 Toast 兜底
  srcChip: {
    flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 156,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line,
  },
  srcChipOn: { backgroundColor: c.tintStrong, borderColor: withA(c.brandA, 0.4) },
  srcChipT: { fontSize: 12, color: c.dim, flexShrink: 1 },
  srcChipTOn: { color: c.brandA, fontWeight: "600" },
  srcDot: { width: 6, height: 6, borderRadius: 3 },
  bypassRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  bypassBox: {
    width: 18, height: 18, borderRadius: 5, borderWidth: 1, borderColor: c.line,
    alignItems: "center", justifyContent: "center",
  },
  bypassBoxOn: { backgroundColor: c.brandA, borderColor: c.brandA },
  bypassCheck: { color: "#fff", fontSize: 12, fontWeight: "700" },
  bypassT: { color: c.dim, fontSize: 12.5, flex: 1 },
  createBtn: {
    height: 48, borderRadius: 14, marginTop: 4, backgroundColor: c.brandA,
    alignItems: "center", justifyContent: "center",
  },
  createT: { color: "#fff", fontSize: 15.5, fontWeight: "700" },
  cancel: { height: 42, marginTop: 8, alignItems: "center", justifyContent: "center" },
  cancelT: { color: c.dim, fontSize: 14 },
});
