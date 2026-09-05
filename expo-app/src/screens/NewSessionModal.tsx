import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { store } from "../store";

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
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loadedInit, setLoadedInit] = useState(false);

  if (visible && !loadedInit) {
    setLoadedInit(true);
    setErr(null);
    void AsyncStorage.getItem("ccr_cwd").then((v) => v && setCwd(v));
  }
  if (!visible && loadedInit) setLoadedInit(false);

  const create = () => {
    const cc = cwd.trim();
    const p = prompt.trim();
    if (!cc) {
      setErr("请填写工作目录（PC 上的项目路径）");
      return;
    }
    if (!p) {
      setErr("请填写任务提示词");
      return;
    }
    setErr(null);
    void AsyncStorage.setItem("ccr_cwd", cc);
    if (store.send("COMMAND_CREATE", { cwd: cc, prompt: p })) {
      setPrompt("");
      onClose();
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={m.mask} onPress={onClose}>
        {/* Modal 独立窗口 decorFitsSystemWindows=true + adjustResize，原生即可避让键盘 */}
        <View style={{ width: "100%" }}>
          <Pressable style={m.sheet} onPress={(e) => e.stopPropagation()}>            <Text style={m.h3}>新建托管会话</Text>
            <View style={m.field}>
              <Text style={m.label}>工作目录（PC 上的路径）</Text>
              <TextInput
                style={[m.input, err && !cwd.trim() && m.inputErr]}
                value={cwd}
                onChangeText={(v) => { setCwd(v); setErr(null); }}
                placeholder="D:\dev\myproject"
                placeholderTextColor={c.faint}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
            </View>
            <View style={m.field}>
              <Text style={m.label}>任务提示词</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={m.presetRow} contentContainerStyle={{ gap: 7 }}>
                {PRESETS.map((p) => (
                  <Pressable
                    key={p.label}
                    style={m.presetChip}
                    android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
                    onPress={() => setPrompt(p.text)}
                  >
                    <Text style={m.presetT}>{p.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <TextInput
                style={[m.input, m.ta, err && !prompt.trim() && m.inputErr]}
                value={prompt}
                onChangeText={(v) => { setPrompt(v); setErr(null); }}
                placeholder="描述要 Claude 做什么…"
                placeholderTextColor={c.faint}
                multiline
              />
            </View>
            {err ? <Text style={m.errT}>{err}</Text> : null}
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
  createBtn: {
    height: 48, borderRadius: 14, marginTop: 4, backgroundColor: c.brandA,
    alignItems: "center", justifyContent: "center",
  },
  createT: { color: "#fff", fontSize: 15.5, fontWeight: "700" },
  cancel: { height: 42, marginTop: 8, alignItems: "center", justifyContent: "center" },
  cancelT: { color: c.dim, fontSize: 14 },
});
