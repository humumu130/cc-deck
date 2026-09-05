import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";

interface Props {
  visible: boolean;
  initial: string;
  onCancel: () => void;
  onSubmit: (title: string) => void;
}

export default function RenameModal({ visible, initial, onCancel, onSubmit }: Props) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const [v, setV] = useState(initial);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (visible) {
      setV(initial);
      setErr(false);
    }
  }, [visible, initial]);
  const submit = () => {
    const t = v.trim();
    if (!t) {
      setErr(true);
      return;
    }
    onSubmit(t.slice(0, 40));
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.mask} onPress={onCancel}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.h}>重命名会话</Text>
          <TextInput
            style={[styles.input, err && styles.inputErr]}
            value={v}
            onChangeText={(t) => { setV(t); setErr(false); }}
            placeholder="会话名称"
            placeholderTextColor={c.faint}
            maxLength={40}
            autoFocus
            selectTextOnFocus
            onSubmitEditing={submit}
            returnKeyType="done"
          />
          {err ? <Text style={styles.errT}>名称不能为空</Text> : null}
          <View style={styles.btnRow}>
            <Pressable style={styles.btn} android_ripple={{ color: c.tintSoft, borderless: false }} onPress={onCancel}>
              <Text style={styles.btnT}>取消</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnGo]} android_ripple={{ color: "rgba(255,255,255,0.18)", borderless: false }} onPress={submit}>
              <Text style={styles.btnGoT}>保存</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  mask: { flex: 1, backgroundColor: c.overlay, alignItems: "center", justifyContent: "center", padding: 36 },
  card: {
    width: "100%", borderRadius: 16, backgroundColor: c.panel,
    borderWidth: 1, borderColor: c.line, padding: 18,
  },
  h: { color: c.text, fontSize: 15.5, fontWeight: "700", marginBottom: 14 },
  input: {
    color: c.text, fontSize: 14.5, borderWidth: 1, borderColor: c.line,
    borderRadius: 10, backgroundColor: c.panel2, paddingHorizontal: 12,
    paddingVertical: 10, marginBottom: 16,
  },
  inputErr: { borderColor: withA(c.waiting, 0.6) },
  errT: { color: c.waiting, fontSize: 12, marginTop: -10, marginBottom: 12 },
  btnRow: { flexDirection: "row", gap: 10 },
  btn: {
    flex: 1, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: c.tintSoft, borderWidth: 1, borderColor: c.line,
  },
  btnT: { color: c.dim, fontSize: 14, fontWeight: "600" },
  btnGo: { backgroundColor: c.brandA, borderColor: withA(c.brandA, 0.6) },
  btnGoT: { color: "#fff", fontSize: 14, fontWeight: "700" },
});
