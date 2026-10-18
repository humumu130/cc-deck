// 建团分步向导（W-EXPODOMAIN v2 件二，design-expo-mobile-v2 B2/A1-12）：桌面建团表单
// （index-005 :6085-6170）的手机等价物——表单一屏塞不下五组字段，分步向导（v1 定案
// 维持）：名称 → 锚点目录（最近项目快捷选）→ 立项档（轻量/正式，载荷发旧词）→
// 成员编制（≤8 席多选 + 角色模板三选 统一 worker/统一 PM/自由编制）→ 确认提交。
// 提交走 COMMAND_ORG_ACTION {action:"create"} 现役通路（relay createGroup 单漏斗；
// 会话在册性由 relay 咽喉校验）；ACK 严格判定门 + 双击闸 + 能力位降级（E2b 口径）。
// 手动席不搬（C-6：桌面自己都未入载荷）；反馈区分 needsConfirm（确认卡决议提示）。
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { FadeIn } from "../motion";
import { useTheme, useThemeStyles } from "../theme-context";
import { withA, type ThemeColors } from "../theme";
import { store, useRelay } from "../store";
import {
  ackTapGuard,
  ackVerdict,
  cmdCapBlocked,
  cmdCapRemember,
  unknownCommandError,
  type AckVerdict,
  type CmdCaps,
} from "../org-commands";
import { tierZh } from "./OrgZone";

// 角色模板三选（桌面同款）：worker=统一执行者 / PM=统一项目管理 / free=自由编制逐人填
type RoleTpl = "worker" | "PM" | "free";
// 自由编制角色词表（桌面 TEAM_ROLE_PRESETS——datalist 建议项，不锁输入）
const ROLE_PRESETS = ["worker", "PM", "reviewer", "qa"];
const TIERS: { v: "轻立项" | "正经立项"; label: string; sub: string }[] = [
  { v: "轻立项", label: "轻量项目", sub: "单卡简化态 · 首次需确认，同类免确认" },
  { v: "正经立项", label: "正式项目", sub: "每次创建都需确认（防误判档烧钱）" },
];

export default function TeamCreateWizard({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const styles = useThemeStyles(makeStyles);
  const snap = useRelay();
  const [step, setStep] = useState(0); // 0 名称 / 1 目录 / 2 档位 / 3 编制 / 4 确认提交
  const [name, setName] = useState("");
  const [anchor, setAnchor] = useState("");
  const [tier, setTier] = useState<"轻立项" | "正经立项">("轻立项");
  const [tpl, setTpl] = useState<RoleTpl>("worker");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [doneNote, setDoneNote] = useState<string | null>(null);
  const CMD = "COMMAND_ORG_ACTION";
  const CAP_MSG = "该源 relay 版本不支持建团，升级 relay 后可用";
  const [flight, setFlight] = useState(false);
  const [caps, setCaps] = useState<CmdCaps>({});

  // 候选会话（桌面 teamCandidates 口径：在册托管会话按更新时间倒序取 12）
  const candidates = useMemo(
    () => snap.sessions.filter((s) => !s.external).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, 12),
    [snap.sessions],
  );
  // 最近项目目录快捷选（会话 cwd 归一去重，最新在前，取 6；v2 件二目录步）
  const recentDirs = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of snap.sessions) {
      const d = String(s.cwd || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
      if (!d || !d.startsWith("/") || seen.has(d)) continue;
      seen.add(d);
      out.push(d);
      if (out.length >= 6) break;
    }
    return out;
  }, [snap.sessions]);

  const reset = () => {
    setStep(0);
    setName("");
    setAnchor("");
    setTier("轻立项");
    setTpl("worker");
    setPicked(new Set());
    setRoles({});
    setErr(null);
    setDoneNote(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const stepValid = (): boolean => {
    if (step === 0) return !!name.trim();
    if (step === 1) return anchor.trim().startsWith("/");
    return true;
  };
  const stepHint = (): string | null => {
    if (step === 0 && !name.trim()) return "先给团队起个名";
    if (step === 1 && !anchor.trim().startsWith("/")) return "锚点目录需是 relay 侧绝对路径（/ 开头，一锚一团）";
    return null;
  };

  const togglePick = (sid: string) => {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(sid)) n.delete(sid);
      else if (n.size >= 8) return prev; // 上限 8 席（relay sanitizeHeadcount 同闸）
      else n.add(sid);
      return n;
    });
  };

  // 提交（ACK 严格判定门链：双击闸 → 能力位 → 发送 → 三态收场）
  const submit = () => {
    if (flight) return;
    if (!name.trim() || !anchor.trim().startsWith("/")) {
      setErr("名称或锚点目录缺失");
      return;
    }
    if (cmdCapBlocked(caps, CMD)) {
      setErr(CAP_MSG);
      return;
    }
    const headcount = [...picked].map((sid) => ({
      session_id: sid,
      role: tpl === "free" ? (roles[sid] || "").trim() || "worker" : tpl,
    }));
    setErr(null);
    setFlight(true);
    const settle = (v: AckVerdict, data?: { needsConfirm?: boolean }): void => {
      setFlight(false);
      if (v.ok) {
        // PROJECTS_UPDATED/ORG_CONFIRM_UPDATED 权威帧自动刷新列表，此处只给结果反馈
        setDoneNote(data?.needsConfirm ? "立项已提交，等你在确认卡上 ✓/✗" : "团队已创建");
        return;
      }
      if (unknownCommandError(v.error)) {
        setCaps((prev) => cmdCapRemember(prev, CMD));
        setErr(CAP_MSG);
        return;
      }
      setErr(v.error ?? "命令未确认（超时或源未连接），可重试");
    };
    const sent = store.send(
      CMD,
      { action: "create", name: name.trim(), anchor_dir: anchor.trim(), tier, ...(headcount.length ? { headcount } : {}) },
      undefined,
      (r) => settle(ackVerdict(r), (r as { data?: { needsConfirm?: boolean } }).data),
    );
    if (!sent) settle(ackVerdict(null));
  };

  const stepTitles = ["名称", "锚点目录", "立项档", "成员编制", "确认提交"];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={styles.page}>
        {/* 头部：步名 + 进度点 + 关闭 */}
        <View style={styles.head}>
          <Text style={styles.headT}>新建团队</Text>
          <View style={styles.dots}>
            {stepTitles.map((t, i) => (
              <View key={t} style={[styles.dot, i === step && styles.dotOn, i < step && styles.dotDone]} />
            ))}
          </View>
          <Pressable hitSlop={10} accessibilityLabel="关闭建团向导" onPress={close}>
            <Text style={styles.headX}>✕</Text>
          </Pressable>
        </View>

        {doneNote ? (
          <View style={styles.doneBox}>
            <Text style={styles.doneT}>{doneNote}</Text>
            <Text style={styles.doneS}>团队列表与确认卡将随后自动出现</Text>
            <Pressable style={styles.doneBtn} android_ripple={{ color: withA(c.brandA, 0.2), borderless: false, radius: 12 }} onPress={close}>
              <Text style={styles.doneBtnT}>完成</Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled"><FadeIn key={step} dy={6} dur={150}>
            {/* 步1 名称 */}
            {step === 0 ? (
              <View style={styles.field}>
                <Text style={styles.label}>团队名</Text>
                <TextInput
                  style={styles.input}
                  value={name}
                  onChangeText={(v) => { setName(v); setErr(null); }}
                  placeholder="如：redbook 推广"
                  placeholderTextColor={c.faint}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                />
              </View>
            ) : null}
            {/* 步2 锚点目录（最近项目快捷选） */}
            {step === 1 ? (
              <View style={styles.field}>
                <Text style={styles.label}>锚点目录（relay 侧绝对路径 · 一锚一团）</Text>
                <TextInput
                  style={styles.input}
                  value={anchor}
                  onChangeText={(v) => { setAnchor(v); setErr(null); }}
                  placeholder="~/dev/myproject"
                  placeholderTextColor={c.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                />
                {recentDirs.length ? (
                  <>
                    <Text style={styles.subLabel}>最近项目</Text>
                    <View style={styles.chips}>
                      {recentDirs.map((d) => {
                        const on = anchor === d;
                        const segs = d.split("/").filter(Boolean);
                        return (
                          <Pressable
                            key={d}
                            style={[styles.chip, on && styles.chipOn]}
                            android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
                            accessibilityLabel={`选用目录 ${segs.slice(-2).join("/")}`}
                            onPress={() => setAnchor(d)}
                          >
                            <Text style={[styles.chipT, on && styles.chipTOn]} numberOfLines={1}>{segs.slice(-2).join("/")}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                ) : null}
              </View>
            ) : null}
            {/* 步3 立项档（显示层口语化，载荷发旧词） */}
            {step === 2 ? (
              <View style={styles.field}>
                <Text style={styles.label}>立项档</Text>
                {TIERS.map((t) => {
                  const on = tier === t.v;
                  return (
                    <Pressable
                      key={t.v}
                      style={[styles.optRow, on && styles.optRowOn]}
                      android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }}
                      accessibilityLabel={`${t.label}，${t.sub}`}
                      onPress={() => setTier(t.v)}
                    >
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[styles.optT, on && styles.optTOn]}>{t.label}</Text>
                        <Text style={styles.optS}>{t.sub}</Text>
                      </View>
                      {on ? <Text style={styles.optCheck}>✓</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            {/* 步4 成员编制（≤8 席 + 角色模板三选） */}
            {step === 3 ? (
              <View style={styles.field}>
                <Text style={styles.label}>成员编制 · 最多 8 席（已选 {picked.size}）</Text>
                <View style={styles.tplRow}>
                  {([["worker", "统一 worker"], ["PM", "统一 PM"], ["free", "自由编制"]] as const).map(([v, lb]) => {
                    const on = tpl === v;
                    return (
                      <Pressable
                        key={v}
                        style={[styles.tplBtn, on && styles.tplBtnOn]}
                        android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
                        accessibilityLabel={`角色模板：${lb}`}
                        onPress={() => setTpl(v)}
                      >
                        <Text style={[styles.tplT, on && styles.tplTOn]}>{lb}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                {candidates.length ? (
                  candidates.map((s) => {
                    const on = picked.has(s.session_id);
                    return (
                      <View key={s.session_id}>
                        <Pressable
                          style={[styles.candRow, on && styles.candRowOn]}
                          android_ripple={{ color: c.tintSoft, borderless: false, radius: 10 }}
                          accessibilityLabel={`${on ? "移出" : "加入"}成员 ${s.title || s.session_id.slice(0, 8)}`}
                          onPress={() => togglePick(s.session_id)}
                        >
                          <View style={[styles.checkBox, on && styles.checkBoxOn]}>
                            {on ? <Text style={styles.checkT}>✓</Text> : null}
                          </View>
                          <Text style={styles.candT} numberOfLines={1}>{s.title || s.session_id.slice(0, 12)}</Text>
                        </Pressable>
                        {/* 自由编制：选中行下展开角色输入 */}
                        {on && tpl === "free" ? (
                          <View style={styles.roleBox}>
                            <Text style={styles.roleLabel}>角色</Text>
                            <TextInput
                              style={styles.roleInput}
                              value={roles[s.session_id] ?? ""}
                              onChangeText={(v) => setRoles((prev) => ({ ...prev, [s.session_id]: v }))}
                              placeholder={ROLE_PRESETS.join(" / ")}
                              placeholderTextColor={c.faint}
                              autoCapitalize="none"
                              autoCorrect={false}
                              spellCheck={false}
                            />
                          </View>
                        ) : null}
                      </View>
                    );
                  })
                ) : (
                  <Text style={styles.hint}>暂无可入编的托管会话——可先建团，稍后在电脑端编制面板补齐成员</Text>
                )}
              </View>
            ) : null}
            {/* 步5 确认提交 */}
            {step === 4 ? (
              <View style={styles.field}>
                <Text style={styles.label}>确认信息</Text>
                <View style={styles.sumRow}><Text style={styles.sumK}>团队名</Text><Text style={styles.sumV} numberOfLines={1}>{name.trim()}</Text></View>
                <View style={styles.sumRow}><Text style={styles.sumK}>锚点目录</Text><Text style={styles.sumV} numberOfLines={2}>{anchor.trim()}</Text></View>
                <View style={styles.sumRow}><Text style={styles.sumK}>立项档</Text><Text style={styles.sumV}>{tierZh(tier)}{tier === "正经立项" ? "（提交后出确认卡待你决议）" : ""}</Text></View>
                <View style={styles.sumRow}>
                  <Text style={styles.sumK}>成员编制</Text>
                  <Text style={styles.sumV} numberOfLines={3}>
                    {picked.size ? [...picked].map((sid) => {
                      const s = snap.sessions.find((x) => x.session_id === sid);
                      const role = tpl === "free" ? (roles[sid] || "").trim() || "worker" : tpl;
                      return `${s?.title || sid.slice(0, 8)}(${role})`;
                    }).join(" · ") : "暂不入编（稍后可在电脑端补齐）"}
                  </Text>
                </View>
              </View>
            ) : null}

            {err ? <Text style={styles.errT}>{err}</Text> : null}
          </FadeIn>
      </ScrollView>
        )}

        {/* 底部步进（结果页隐藏） */}
        {!doneNote ? (
          <View style={styles.foot}>
            {step > 0 ? (
              <Pressable style={styles.btnSub} android_ripple={{ color: c.tintSoft, borderless: false, radius: 12 }} onPress={() => { setErr(null); setStep((v) => v - 1); }}>
                <Text style={styles.btnSubT}>上一步</Text>
              </Pressable>
            ) : null}
            {step < 4 ? (
              <Pressable
                style={[styles.btnMain, !stepValid() && styles.btnOff]}
                disabled={!stepValid()}
                android_ripple={{ color: withA(c.brandA, 0.2), borderless: false, radius: 12 }}
                onPress={() => { setErr(stepHint()); if (stepValid()) setStep((v) => v + 1); }}
              >
                <Text style={styles.btnMainT}>下一步</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.btnMain, flight && styles.btnOff]}
                disabled={flight}
                android_ripple={{ color: withA(c.brandA, 0.2), borderless: false, radius: 12 }}
                onPress={submit}
              >
                <Text style={styles.btnMainT}>{flight ? "提交中…" : "创建团队"}</Text>
              </Pressable>
            )}
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: c.bg },
    head: {
      flexDirection: "row", alignItems: "center", gap: 10,
      paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line,
    },
    headT: { color: c.text, fontSize: 15.5, fontWeight: "700" },
    dots: { flexDirection: "row", gap: 5, flex: 1, justifyContent: "center" },
    dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: withA(c.faint, 0.35) },
    dotOn: { backgroundColor: c.brandA },
    dotDone: { backgroundColor: withA(c.done, 0.6) },
    headX: { color: c.dim, fontSize: 16, padding: 4 },
    body: { padding: 16, paddingBottom: 30, gap: 8 },
    field: { gap: 7 },
    label: { color: c.dim, fontSize: 12, fontWeight: "600" },
    subLabel: { color: c.faint, fontSize: 11, marginTop: 6 },
    input: {
      backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, borderRadius: 12,
      paddingHorizontal: 13, paddingVertical: 11, color: c.text, fontSize: 15,
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
    chip: {
      paddingHorizontal: 11, paddingVertical: 6, borderRadius: 12, maxWidth: 200,
      backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, overflow: "hidden",
    },
    chipOn: { borderColor: withA(c.brandA, 0.5), backgroundColor: withA(c.brandA, 0.1) },
    chipT: { color: c.dim, fontSize: 12 },
    chipTOn: { color: c.brandA, fontWeight: "600" },
    optRow: {
      flexDirection: "row", alignItems: "center", gap: 10,
      borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel,
      paddingHorizontal: 13, paddingVertical: 12, overflow: "hidden",
    },
    optRowOn: { borderColor: withA(c.brandA, 0.55), backgroundColor: withA(c.brandA, 0.07) },
    optT: { color: c.text, fontSize: 14, fontWeight: "600" },
    optTOn: { color: c.brandA },
    optS: { color: c.faint, fontSize: 11, marginTop: 2 },
    optCheck: { color: c.brandA, fontSize: 15, fontWeight: "700" },
    tplRow: { flexDirection: "row", gap: 8 },
    tplBtn: {
      flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 10,
      borderWidth: 1, borderColor: c.line, backgroundColor: c.panel, overflow: "hidden",
    },
    tplBtnOn: { borderColor: withA(c.brandA, 0.55), backgroundColor: withA(c.brandA, 0.07) },
    tplT: { color: c.dim, fontSize: 12 },
    tplTOn: { color: c.brandA, fontWeight: "700" },
    candRow: {
      flexDirection: "row", alignItems: "center", gap: 10,
      borderRadius: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel,
      paddingHorizontal: 11, paddingVertical: 10, overflow: "hidden",
    },
    candRowOn: { borderColor: withA(c.brandA, 0.5), backgroundColor: withA(c.brandA, 0.05) },
    checkBox: {
      width: 19, height: 19, borderRadius: 6, borderWidth: 1.5, borderColor: c.line,
      alignItems: "center", justifyContent: "center",
    },
    checkBoxOn: { backgroundColor: c.brandA, borderColor: c.brandA },
    checkT: { color: "#fff", fontSize: 12, fontWeight: "700" },
    candT: { color: c.text, fontSize: 13, flexShrink: 1 },
    roleBox: { flexDirection: "row", alignItems: "center", gap: 8, marginLeft: 29, marginBottom: 7 },
    roleLabel: { color: c.faint, fontSize: 11 },
    roleInput: {
      flex: 1, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, borderRadius: 9,
      paddingHorizontal: 10, paddingVertical: 7, color: c.text, fontSize: 13,
    },
    hint: { color: c.faint, fontSize: 11.5, lineHeight: 16 },
    sumRow: { flexDirection: "row", gap: 10, paddingVertical: 5 },
    sumK: { color: c.faint, fontSize: 12, width: 62, flexShrink: 0 },
    sumV: { color: c.text, fontSize: 12.5, flex: 1, lineHeight: 17 },
    errT: { color: c.error, fontSize: 12, marginTop: 8, lineHeight: 16 },
    foot: {
      flexDirection: "row", gap: 10, padding: 14, paddingTop: 10,
      borderTopWidth: 1, borderTopColor: c.line,
    },
    btnSub: {
      height: 44, paddingHorizontal: 18, borderRadius: 12, alignItems: "center", justifyContent: "center",
      backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, overflow: "hidden",
    },
    btnSubT: { color: c.dim, fontSize: 13.5, fontWeight: "600" },
    btnMain: {
      flex: 1, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center",
      backgroundColor: c.brandA, overflow: "hidden",
    },
    btnOff: { opacity: 0.45 },
    btnMainT: { color: "#fff", fontSize: 14, fontWeight: "700" },
    doneBox: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 8 },
    doneT: { color: c.done, fontSize: 16, fontWeight: "700", textAlign: "center" },
    doneS: { color: c.faint, fontSize: 12, textAlign: "center" },
    doneBtn: {
      height: 42, paddingHorizontal: 34, borderRadius: 12, marginTop: 12,
      backgroundColor: c.brandA, alignItems: "center", justifyContent: "center", overflow: "hidden",
    },
    doneBtnT: { color: "#fff", fontSize: 14, fontWeight: "700" },
  });
