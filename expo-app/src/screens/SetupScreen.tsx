import { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";
import { withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { store, useRelay, type ServerEntry } from "../store";
import { uuid } from "../fmt";
import { useKbHeight } from "../kb";

interface Props {
  onClose?: () => void; // 有值 = 从主界面进入（可返回）
}

function hostOf(wsUrl: string): string {
  try {
    return new URL(wsUrl).host;
  } catch {
    return wsUrl;
  }
}

export default function SetupScreen({ onClose }: Props) {
  const { c } = useTheme();
  const s = useThemeStyles(makeStyles);
  const snap = useRelay();
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [wsUrl, setWsUrl] = useState("ws://192.168.0.105:8787/ws");
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(true);
  const kb = useKbHeight();

  const reload = async () => {
    setServers(await store.loadServers());
    setActiveId(await store.activeServerId());
  };
  useEffect(() => {
    void reload();
    void AsyncStorage.getItem("ccr_remember_token").then((v) => {
      if (v === "0") setRemember(false);
    });
  }, []);
  // 配对完成后 store 已更新条目，这里同步刷新列表（显示 ☁ 徽标）
  useEffect(() => {
    void reload();
  }, [snap.cloudMsg]);

  // 返回手势/返回键回到主界面（仅从 ⚙ 进入时；首次配置无路可退）
  useEffect(() => {
    if (!onClose) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const toggleRemember = () => {
    setRemember((v) => {
      void AsyncStorage.setItem("ccr_remember_token", v ? "0" : "1");
      return !v;
    });
  };

  const add = () => {
    const base = wsUrl.trim().replace(/\/+$/, "");
    const tk = token.trim();
    if (!/^wss?:\/\//.test(base) || !tk) return;
    const entry: ServerEntry = {
      id: uuid(),
      name: name.trim() || hostOf(base),
      wsUrl: base,
      token: remember ? tk : "",   // 不记住：条目只存地址，令牌仅本次连接用
    };
    void store.connectServer(entry, tk).then(() => {
      setActiveId(entry.id);
      if (onClose) onClose(); // 首次连接的导航由 App 在 connected 后接管
    });
  };

  const connect = (e: ServerEntry) => {
    if (!e.token) {
      // 没记令牌：预填表单让用户补输
      setName(e.name);
      setWsUrl(e.wsUrl);
      setToken("");
      return;
    }
    void store.connectServer(e).then(() => {
      setActiveId(e.id);
      if (onClose) onClose();
    });
  };

  const remove = (e: ServerEntry) => {
    void store.deleteServer(e.id).then(() => reload());
  };

  return (
    <SafeAreaView style={s.safe} edges={onClose ? ["top"] : []}>
      <View style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ ...s.wrap, paddingBottom: 36 + kb }}
          keyboardShouldPersistTaps="handled"
        >
          <LinearGradient colors={[c.brandA, c.brandB]} style={s.logo} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
            <Text style={s.logoText}>CC</Text>
          </LinearGradient>
          <Text style={s.h2}>Cloud Code</Text>
          <Text style={s.sub}>连接到 PC Relay</Text>

          {servers.length > 0 ? (
            <View style={s.savedBox}>
              <Text style={s.label}>已保存的服务器</Text>
              {servers.map((e) => {
                const active = e.id === activeId;
                return (
                  <View key={e.id} style={[s.srvRow, active && s.srvRowOn]}>
                    <Pressable style={s.srvMain} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={() => connect(e)}>
                      <View style={s.srvHead}>
                        {active ? <View style={[s.srvDot, { backgroundColor: c.done }]} /> : null}
                        <Text style={s.srvName} numberOfLines={1}>{e.name}</Text>
                        {e.cloud ? <Text style={s.srvCloud}>☁</Text> : null}
                      </View>
                      <Text style={s.srvUrl} numberOfLines={1}>{e.wsUrl}</Text>
                    </Pressable>
                    <Pressable style={s.srvDel} android_ripple={{ color: withA(c.waiting, 0.15), borderless: false, radius: 14 }} onPress={() => remove(e)}>
                      <Text style={s.srvDelT}>✕</Text>
                    </Pressable>
                  </View>
                );
              })}
              <View style={s.pairRow}>
                <Pressable
                  style={[s.pairBtn, !(snap.connected && snap.channel === "lan") && s.pairBtnOff]}
                  disabled={snap.cloudBusy || !(snap.connected && snap.channel === "lan")}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 17 }}
                  onPress={() => void store.pairCloud()}
                >
                  <Text style={s.pairBtnT}>
                    {snap.cloudBusy ? "配对中…" : servers.find((e) => e.id === activeId)?.cloud ? "重新配对云桥" : "配对云桥"}
                  </Text>
                </Pressable>
              </View>
              {snap.cloudMsg ? (
                <Pressable hitSlop={6} onPress={() => store.clearCloudMsg()}>
                  <Text style={s.pairMsg} numberOfLines={2}>{snap.cloudMsg}</Text>
                </Pressable>
              ) : !(snap.connected && snap.channel === "lan") ? (
                <Text style={s.pairHint}>云桥配对需先在同一局域网内连接</Text>
              ) : null}
            </View>
          ) : null}

          <View style={s.field}>
            <Text style={s.label}>名称（可选）</Text>
            <TextInput
              style={s.input}
              value={name}
              onChangeText={setName}
              placeholder="书房电脑"
              placeholderTextColor={c.faint}
            />
          </View>
          <View style={s.field}>
            <Text style={s.label}>Relay 地址</Text>
            <TextInput
              style={s.input}
              value={wsUrl}
              onChangeText={setWsUrl}
              placeholder="ws://192.168.0.105:8787/ws"
              placeholderTextColor={c.faint}
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
              placeholderTextColor={c.faint}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
            />
          </View>
          <Pressable style={s.checkRow} onPress={toggleRemember} hitSlop={6}>
            <View style={[s.checkBox, remember && s.checkBoxOn]}>
              {remember ? <Text style={s.checkT}>✓</Text> : null}
            </View>
            <Text style={s.checkLabel}>记住令牌（下次免输入）</Text>
          </Pressable>
          <Pressable style={s.btn} android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false }} onPress={add}>
            <LinearGradient colors={[c.brandA, c.brandB]} style={s.btnGrad}>
              <Text style={s.btnText}>{servers.length > 0 ? "添加并连接" : "连接"}</Text>
            </LinearGradient>
          </Pressable>
          <Text style={s.hint}>手机需与 PC 在同一 WiFi；地址填 PC 上的 ws://IP:8787/ws</Text>
          {onClose ? (
            <Pressable style={s.back} android_ripple={{ color: c.tintSoft, borderless: false, radius: 20 }} onPress={onClose}>
              <Text style={s.backT}>返回</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  wrap: { alignItems: "center", paddingTop: 72, paddingBottom: 36, paddingHorizontal: 28 },
  logo: { width: 64, height: 64, borderRadius: 19, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  logoText: { color: "#fff", fontWeight: "800", fontSize: 22 },
  h2: { color: c.text, fontSize: 21, fontWeight: "700" },
  sub: { color: c.dim, fontSize: 13, marginTop: 4, marginBottom: 24 },
  savedBox: { width: "100%", maxWidth: 340, marginBottom: 20 },
  label: { color: c.dim, fontSize: 12, marginBottom: 6 },
  srvRow: {
    flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: c.line,
    borderRadius: 13, backgroundColor: c.panel, marginBottom: 8, overflow: "hidden",
  },
  srvRowOn: { borderColor: withA(c.done, 0.45), backgroundColor: withA(c.done, 0.05) },
  srvMain: { flex: 1, paddingVertical: 10, paddingLeft: 12, paddingRight: 4 },
  srvHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  srvDot: { width: 7, height: 7, borderRadius: 4 },
  srvName: { color: c.text, fontSize: 14, fontWeight: "600" },
  srvUrl: { color: c.faint, fontSize: 11, marginTop: 2 },
  srvDel: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  srvDelT: { color: c.faint, fontSize: 15 },
  srvCloud: { color: c.done, fontSize: 12 },
  pairRow: { marginTop: 4, alignSelf: "flex-start" },
  pairBtn: {
    paddingHorizontal: 16, paddingVertical: 7, borderRadius: 17, borderWidth: 1,
    borderColor: withA(c.brandA, 0.55), backgroundColor: withA(c.brandA, 0.06),
  },
  pairBtnOff: { borderColor: c.line, backgroundColor: "transparent" },
  pairBtnT: { color: c.dim, fontSize: 13, fontWeight: "600" },
  pairMsg: { color: c.dim, fontSize: 12, marginTop: 8 },
  pairHint: { color: c.faint, fontSize: 12, marginTop: 8 },
  field: { width: "100%", maxWidth: 340, marginBottom: 12 },
  input: {
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, borderRadius: 12,
    paddingHorizontal: 13, paddingVertical: 11, color: c.text, fontSize: 15,
  },
  btn: { width: "100%", maxWidth: 340, marginTop: 8, borderRadius: 14, overflow: "hidden" },
  btnGrad: { height: 48, alignItems: "center", justifyContent: "center" },
  btnText: { color: "#fff", fontSize: 15.5, fontWeight: "700" },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 8, width: "100%", maxWidth: 340, marginBottom: 4, alignSelf: "flex-start" },
  checkBox: {
    width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: c.line,
    backgroundColor: c.panel2, alignItems: "center", justifyContent: "center",
  },
  checkBoxOn: { backgroundColor: c.brandA, borderColor: c.brandA },
  checkT: { color: "#fff", fontSize: 13, fontWeight: "700" },
  checkLabel: { color: c.dim, fontSize: 13 },
  hint: { color: c.faint, fontSize: 12, marginTop: 16, textAlign: "center", maxWidth: 320 },
  back: { marginTop: 14, paddingHorizontal: 22, paddingVertical: 8, borderRadius: 20 },
  backT: { color: c.dim, fontSize: 14 },
});
