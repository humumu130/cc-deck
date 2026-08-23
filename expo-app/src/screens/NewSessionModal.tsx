import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { C } from "../theme";
import { store } from "../store";

export default function NewSessionModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [loadedInit, setLoadedInit] = useState(false);

  if (visible && !loadedInit) {
    setLoadedInit(true);
    void AsyncStorage.getItem("ccr_cwd").then((v) => v && setCwd(v));
  }
  if (!visible && loadedInit) setLoadedInit(false);

  const create = () => {
    const c = cwd.trim();
    const p = prompt.trim();
    if (!c || !p) return;
    void AsyncStorage.setItem("ccr_cwd", c);
    if (store.send("COMMAND_CREATE", { cwd: c, prompt: p })) {
      setPrompt("");
      onClose();
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={m.mask} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ width: "100%" }}>
          <Pressable style={m.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={m.h3}>新建托管会话</Text>
            <View style={m.field}>
              <Text style={m.label}>工作目录（PC 上的路径）</Text>
              <TextInput
                style={m.input}
                value={cwd}
                onChangeText={setCwd}
                placeholder="D:\dev\myproject"
                placeholderTextColor={C.faint}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
            </View>
            <View style={m.field}>
              <Text style={m.label}>任务提示词</Text>
              <TextInput
                style={[m.input, m.ta]}
                value={prompt}
                onChangeText={setPrompt}
                placeholder="描述要 Claude 做什么…"
                placeholderTextColor={C.faint}
                multiline
              />
            </View>
            <Pressable style={({ pressed }) => [m.createBtn, pressed && { opacity: 0.85 }]} onPress={create}>
              <Text style={m.createT}>启动会话</Text>
            </Pressable>
            <Pressable style={m.cancel} onPress={onClose}>
              <Text style={m.cancelT}>取消</Text>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const m = StyleSheet.create({
  mask: { flex: 1, backgroundColor: "rgba(2,5,10,0.65)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#0A141F", borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderTopColor: C.line, paddingHorizontal: 16,
    paddingTop: 18, paddingBottom: 30,
  },
  h3: { color: C.text, fontSize: 16, fontWeight: "700", marginBottom: 14 },
  field: { marginBottom: 12 },
  label: { color: C.dim, fontSize: 12, marginBottom: 6 },
  input: {
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 12,
    paddingHorizontal: 13, paddingVertical: 11, color: C.text, fontSize: 15,
  },
  ta: { minHeight: 88, textAlignVertical: "top" },
  createBtn: {
    height: 48, borderRadius: 14, marginTop: 4, backgroundColor: C.brandA,
    alignItems: "center", justifyContent: "center",
  },
  createT: { color: "#fff", fontSize: 15.5, fontWeight: "700" },
  cancel: { height: 42, marginTop: 8, alignItems: "center", justifyContent: "center" },
  cancelT: { color: C.dim, fontSize: 14 },
});
