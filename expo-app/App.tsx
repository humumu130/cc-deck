import { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View, Vibration } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { store, useRelay } from "./src/store";
import ListScreen from "./src/screens/ListScreen";
import DetailScreen from "./src/screens/DetailScreen";
import SetupScreen from "./src/screens/SetupScreen";
import NewSessionModal from "./src/screens/NewSessionModal";

function Toast() {
  const snap = useRelay();
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!snap.lastErrorCmd) return;
    setShow(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setShow(false);
      store.clearCmdError();
    }, 2600);
  }, [snap.lastErrorCmd]);

  if (!show || !snap.lastErrorCmd) return null;
  return (
    <View style={st.toastWrap} pointerEvents="none">
      <View style={st.toast}>
        <Text style={st.toastT}>命令失败: {snap.lastErrorCmd}</Text>
      </View>
    </View>
  );
}

export default function App() {
  const snap = useRelay();
  const [ready, setReady] = useState(false);
  const [hasCfg, setHasCfg] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    void store.loadConfig().then((cfg) => {
      setHasCfg(!!cfg);
      if (cfg) store.connect();
      setReady(true);
    });
  }, []);

  useEffect(() => {
    store.onWaiting = () => {
      try {
        Vibration.vibrate([0, 90, 60, 90]);
      } catch {}
    };
    return () => {
      store.onWaiting = null;
    };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active" && hasCfg && !snap.connected) store.connect();
    });
    return () => sub.remove();
  }, [hasCfg, snap.connected]);

  if (!ready) {
    return (
      <View style={st.boot}>
        <Text style={st.bootT}>CC Watch</Text>
      </View>
    );
  }

  if (!hasCfg) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <SetupScreen />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {detail ? (
        <DetailScreen sid={detail} onBack={() => setDetail(null)} />
      ) : (
        <ListScreen
          sessions={snap.sessions}
          connected={snap.connected}
          connText={snap.connText}
          onOpen={setDetail}
          onNew={() => setSheet(true)}
        />
      )}
      <NewSessionModal visible={sheet} onClose={() => setSheet(false)} />
      <Toast />
    </SafeAreaProvider>
  );
}

const st = StyleSheet.create({
  boot: { flex: 1, backgroundColor: "#050B12", alignItems: "center", justifyContent: "center" },
  bootT: { color: "#4A5F78", fontSize: 16, fontWeight: "600" },
  toastWrap: { position: "absolute", left: 0, right: 0, bottom: 96, alignItems: "center", zIndex: 90 },
  toast: {
    backgroundColor: "#16283D", borderWidth: 1, borderColor: "rgba(125,165,220,0.10)",
    borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10, maxWidth: "86%",
  },
  toastT: { color: "#E8F0FA", fontSize: 13.5, textAlign: "center" },
});
