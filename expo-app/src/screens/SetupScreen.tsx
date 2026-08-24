import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { C } from "../theme";
import { store } from "../store";

export default function SetupScreen() {
  const [wsUrl, setWsUrl] = useState("ws://192.168.0.105:8787/ws");
  const [token, setToken] = useState("");

  const save = () => {
    const base = wsUrl.trim().replace(/\/+$/, "");
    const tk = token.trim();
    if (!/^wss?:\/\//.test(base) || !tk) return;
    void store.saveConfig({ wsUrl: base, token: tk });
  };

  return (
    <KeyboardAvoidingView style={s.wrap} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <LinearGradient colors={[C.brandA, C.brandB]} style={s.logo} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
        <Text style={s.logoText}>CC</Text>
      </LinearGradient>
      <Text style={s.h2}>Cloud Code</Text>
      <Text style={s.sub}>连接到 PC Relay</Text>

      <View style={s.field}>
        <Text style={s.label}>Relay 地址</Text>
        <TextInput
          style={s.input}
          value={wsUrl}
          onChangeText={setWsUrl}
          placeholder="ws://192.168.0.105:8787/ws"
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      </View>
      <View style={s.field}>
        <Text style={s.label}>访问令牌</Text>
        <TextInput
          style={s.input}
          value={token}
          onChangeText={setToken}
          placeholder="token"
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      </View>
      <Pressable style={s.btn} android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false }} onPress={save}>
        <LinearGradient colors={[C.brandA, C.brandB]} style={s.btnGrad}>
          <Text style={s.btnText}>连接</Text>
        </LinearGradient>
      </Pressable>
      <Text style={s.hint}>手机需与 PC 在同一 WiFi；地址填 PC 上的 ws://IP:8787/ws</Text>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 28 },
  logo: { width: 64, height: 64, borderRadius: 19, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  logoText: { color: "#fff", fontWeight: "800", fontSize: 22 },
  h2: { color: C.text, fontSize: 21, fontWeight: "700" },
  sub: { color: C.dim, fontSize: 13, marginTop: 4, marginBottom: 28 },
  field: { width: "100%", maxWidth: 340, marginBottom: 12 },
  label: { color: C.dim, fontSize: 12, marginBottom: 6 },
  input: {
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 12,
    paddingHorizontal: 13, paddingVertical: 11, color: C.text, fontSize: 15,
  },
  btn: { width: "100%", maxWidth: 340, marginTop: 8, borderRadius: 14, overflow: "hidden" },
  btnGrad: { height: 48, alignItems: "center", justifyContent: "center" },
  btnText: { color: "#fff", fontSize: 15.5, fontWeight: "700" },
  hint: { color: C.faint, fontSize: 12, marginTop: 16, textAlign: "center", maxWidth: 320 },
});
