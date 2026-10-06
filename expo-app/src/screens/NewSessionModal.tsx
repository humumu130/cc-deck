import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ENGINE_ACCENT, withA, type ThemeColors } from "../theme";
import { useTheme, useThemeStyles } from "../theme-context";
import { store, useRelay } from "../store";
import { PERM_CAP_STATE_LABEL, effectiveNoteOf, forbiddenReasonOf } from "../permission";
import {
  ENGINE_PHRASES,
  ENGINE_STATE_LABEL,
  engineDowngradeNote,
  engineLabelOf,
  enginePresetOf,
  engineSelectable,
  engineSummaryLine,
  type EngineCatalogState,
} from "../protocol";
// E2c：判定门纯函数直用 ListScreen E2B-COMMANDS 锚点段导出（零复制粘贴，W1b/E2b
// 两端同语义不共享代码口径的 expo 侧复用面——锚点段自包含零 RN 依赖）
import {
  ackTapGuard,
  ackVerdict,
  cmdCapBlocked,
  cmdCapRemember,
  orgFlightKey,
  unknownCommandError,
  type AckVerdict,
  type CmdCaps,
} from "./ListScreen";

// 任务模板：点击填入提示词（不自动提交）
const PRESETS: { label: string; text: string }[] = [
  { label: "修复构建", text: "运行构建，分析报错并修复，直到构建通过。" },
  { label: "跑测试", text: "运行测试套件，修复所有失败的测试。" },
  { label: "代码审查", text: "审查最近的改动（git diff），指出问题并给出改进建议。" },
  { label: "继续未完成", text: "查看当前工作状态，继续完成未完成的任务。" },
];

// 75-E 状态词徽章配色（跨端 token 陷阱对照 theme.ts 后钉死）：ready=done 绿 /
// unavailable=working 琥珀（警示非错误，P81-8EFIX 三态色同语义档）/ unsupported=
// error 红橙 / unknown=faint 灰。expo waiting=#F0524F 是红（跨端 token 同名异色，
// 非 web waiting 语义），本映射全程不用 waiting——引擎标识色另走 ENGINE_ACCENT
//（005 词表），两套不同轴勿混
const ENGINE_STATE_COLOR: Record<EngineCatalogState, keyof ThemeColors> = {
  ready: "done",
  unavailable: "working",
  unsupported: "error",
  unknown: "faint",
};

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
  // 75-E 引擎/模型选择器：「auto」= 跟随预置（不发 engine，relay 按 role/源默认）；
  // 其值=显式引擎 id（发 engine + selection_source:"manual"，可带 model）。modelSel
  // 为 null = 使用引擎默认（不冒充 SNAPSHOT.models 清单——那是 Claude 回退清单）
  const [engineSel, setEngineSel] = useState("auto");
  const [modelSel, setModelSel] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadedInit, setLoadedInit] = useState(false);

  // E2c：新建会话判定门全链（ListScreen orgDecide 同构）。COMMAND_CREATE 走 ACK
  // 严格三态：ok=不本地造会话（等 SNAPSHOT 权威帧落表）、清 prompt+收弹窗；
  // rejected=relay 错误透传行内可重试；unconfirmed=断连拒发/超时收摊统一文案。
  // 旧 relay 未知命令签名 → 记能力位静默降级（弹窗内提示，不轰炸）；双击闸防
  // 重复建会话；无自动重试（重试=用户重点；store 全局 4s 重发同 id 一次+6s 收摊封顶）
  const CREATE_CMD = "COMMAND_CREATE";
  const CREATE_CAP_MSG = "该源 relay 版本不支持新建会话，升级 relay 后可用";
  const [createFlight, setCreateFlight] = useState<Set<string>>(new Set());
  const [createCaps, setCreateCaps] = useState<CmdCaps>({});

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
  // P81-8E 权限摘要（作业⑤只读衔接：浮层权限摘要行 + 旧 codex 熄灭迁移的判定数据
  // 源，零权限求值复制）；75-E 引擎目录（store normalizeSnapshotPayload 已收容，
  // 旧 relay 无字段 = undefined → 选择器降级旧默认路径）
  const targetSource = (multi ? snap.sources.find((x) => x.id === effTarget) : plat) ?? null;
  const permSummaries = targetSource?.sourceCapabilities?.permission;
  const catalog = targetSource?.sourceCapabilities?.engine_catalog;
  // 75-E 迁移（PM-75 §7.3，派单作业②）：ccr_use_codex 旧 checkbox 偏好 → 选择器
  // engine=codex 带入（记忆口径保留：选回 codex 写 1、改选/auto 写 0，兼容行为不删）；
  // 带入的 codex 在当前源不可选（unsupported/unavailable/preflight fail）→ 熄灭回
  // auto + 记忆回关（原残留熄灭 useEffect 随 checkbox 迁移至此）
  const codexEntry = catalog?.find((e) => e.id === "codex");
  const codexBlock = codexEntry ? engineSelectable(codexEntry) : null;
  useEffect(() => {
    if (engineSel === "codex" && codexBlock) {
      setEngineSel("auto");
      setModelSel(null);
      void AsyncStorage.setItem("ccr_use_codex", "0");
    }
  }, [engineSel, codexBlock]);
  // 聚合多源切目标 → 目录/权限全换，选择重置 auto（显式引擎在新源目录可能不存在，
  // 残留会把失效引擎发出去；codex 记忆带入只在开弹窗时做一次，切源不重带入）
  useEffect(() => {
    setEngineSel("auto");
    setModelSel(null);
  }, [effTarget]);

  if (visible && !loadedInit) {
    setLoadedInit(true);
    setErr(null);
    setTargetId(null);
    setEngineSel("auto");
    setModelSel(null);
    setPickerOpen(false);
    setCreateFlight(new Set()); // 残留飞行表清位（能力位 createCaps 不清：relay 版本记忆跨开合有效）
    void AsyncStorage.getItem("ccr_cwd").then((v) => v && setCwd(v));
    void AsyncStorage.getItem("ccr_auto_mkdir").then((v) => setAutoMkdir(v === "1"));
    void AsyncStorage.getItem("ccr_use_codex").then((v) => {
      // 仅当仍 auto 才带入（防 AsyncStorage 异步回调覆盖用户已做选择）
      if (v === "1") setEngineSel((cur) => (cur === "auto" ? "codex" : cur));
    });
    void AsyncStorage.getItem("ccr_new_target").then((v) => {
      if (v && snap.sources.some((x) => x.id === v)) setTargetId(v);
    });
  }
  if (!visible && loadedInit) setLoadedInit(false);

  // 显式引擎（auto 不指定——relay 按 role/源默认解析，payload 无 engine 保旧 relay
  // 行为）；手动选择带 selection_source:"manual"（PM-75 §7.2，不新开命令）；expo 无
  // 组上下文，gid/role 不传（可选字段）；model 仅显式选了模型才带（null=引擎默认）
  const engineExplicit = engineSel !== "auto" ? engineSel : null;
  const engineName = (id: string): string => catalog?.find((e) => e.id === id)?.label ?? id;

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
    // 75-E 创建前阻止（派单作业③）：显式选了不可选引擎（未安装/不支持/预检失败）
    // → 行内原因，不发送（engineSelectable 与选择器灰显同一把尺；auto 不拦——
    // 默认引擎不可用由 relay 端兜底，端上不探测）
    if (catalog && engineExplicit) {
      const selEntry = catalog.find((e) => e.id === engineExplicit);
      const block = selEntry ? engineSelectable(selEntry) : null;
      if (selEntry && block) {
        setErr(`引擎 ${engineLabelOf(selEntry)} 不可用：${block}`);
        return;
      }
    }
    setErr(null);
    void AsyncStorage.setItem("ccr_cwd", cc);
    // 判定门链（orgDecide 同序）：双击闸 → 能力位降级 → 发送 → onAck 三态收场。
    // 失败内联报错不关弹窗：全局 Toast 被 RN Modal 原生层压住，store 反馈在本弹窗
    // 里永远看不见，必须行内呈现
    const fk = orgFlightKey(effTarget ?? "active", "create");
    if (ackTapGuard(createFlight, fk) === "skip") return;
    if (cmdCapBlocked(createCaps, CREATE_CMD)) {
      setErr(CREATE_CAP_MSG);
      return;
    }
    setCreateFlight((prev) => new Set(prev).add(fk));
    const settle = (v: AckVerdict, perm?: { normalized: string; effective: string; native_mode: string | null; reason: string }, ackEngine?: string): void => {
      setCreateFlight((prev) => {
        const n = new Set(prev);
        n.delete(fk);
        return n;
      });
      if (v.ok) {
        // 成功不本地造会话状态（等 SNAPSHOT 权威帧落表），清 prompt+收弹窗。
        // P81-8E：ACK permission 降级（effective≠normalized）→ 全局 toast 人话——
        // 会话仍创建成功（权威帧会落表），提示不拦不造本地状态。
        // 75-E：ACK engine 与请求不一致 → 同通道标「已降级」不静默（旧 relay ACK
        // 无 engine 字段 = undefined，不比较不提示）
        const note = effectiveNoteOf(perm);
        if (note) store.notifyCmdError(note);
        const engNote = engineDowngradeNote(engineExplicit, ackEngine, engineName);
        if (engNote) store.notifyCmdError(engNote);
        setPrompt("");
        onClose();
        return;
      }
      if (unknownCommandError(v.error)) {
        setCreateCaps((prev) => cmdCapRemember(prev, CREATE_CMD));
        setErr(CREATE_CAP_MSG);
        return;
      }
      // P81-8E forbidden 拒绝面：reason 码 → 三端统一词表人话（词表外码兜底
      // 「已拒绝（<码>）」）；非 forbidden 错误原样透传
      const fr = forbiddenReasonOf(v.error);
      setErr(fr ?? v.error ?? "命令未确认（超时或源未连接），可重试");
    };
    const sent = store.send(
      "COMMAND_CREATE",
      {
        cwd: cc,
        prompt: "" + p,
        ...(bypass ? { permissionMode: "bypassPermissions" as const } : {}),
        ...(autoMkdir ? { autoMkdir: true } : {}),
        ...(engineExplicit
          ? { engine: engineExplicit, selection_source: "manual", ...(modelSel ? { model: modelSel } : {}) }
          : {}),
      },
      multi ? effTarget ?? undefined : undefined,
      (r) => settle(ackVerdict(r), r.permission, r.engine),
    );
    if (!sent) settle(ackVerdict(null)); // 断连拒发：同 unconfirmed 口径，不静默丢单
  };

  // ---------- 75-E 选择器渲染数据（纯函数产出，降级矩阵见 engineSummaryLine） ----------
  // 摘要行主句/副句/可点开；预置条目（跟随预置行副句）；权限摘要行（P81 资产只读
  // 复用，PERM_CAP_STATE_LABEL 词表钉死——此处仅「·」前主词显示裁剪，零求值零复制）
  const summary = engineSummaryLine({ catalog, selected: engineSel, model: engineExplicit ? modelSel : null });
  const presetEntry = catalog ? enginePresetOf(catalog) : null;
  const roleCap = (role: string): string => role.charAt(0).toUpperCase() + role.slice(1);
  const permLine = permSummaries?.length
    ? permSummaries.map((p) => `${engineName(p.engine)} ${PERM_CAP_STATE_LABEL[p.capability_state].split(" ·")[0]}`).join(" · ")
    : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={m.mask} onPress={onClose}>
        {/* Modal 独立窗口 decorFitsSystemWindows=true + adjustResize，原生即可避让键盘 */}
        <View style={{ width: "100%" }}>
          <Pressable style={m.sheet} onPress={(e) => e.stopPropagation()}>
            {/* P81-8E 修复存量红错（3918bae v0.1.8 滑入）：同行空格串被 JSX 保留为
                sheet Pressable 的裸文本子节点 → RN「Text strings must be rendered
                within a <Text>」每次开弹窗必炸（LogBox 栈钉死 167:11 + tsc transform
                children: ["            ", …] 实证）。含换行的标准缩进才会被 JSX 裁剪 */}
            <Text style={m.h3}>新建托管会话</Text>
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
            {/* 75-E 引擎/模型选择器（PM-75 §4.2 expo 形态）：摘要行 + 紧凑浮层两层。
                提交按钮仍唯一——浮层内选择只改本地 state，摘要行实时反映覆盖关系
                （手动改选副行「已覆盖预置」，不回写 role_defaults） */}
            <Pressable
              style={m.engSummary}
              disabled={!summary.overridable}
              accessibilityLabel={`引擎与模型，当前 ${summary.headline}${summary.overridable ? "，点按更改" : ""}`}
              onPress={() => setPickerOpen((v) => !v)}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={m.label}>引擎 / 模型</Text>
                <Text style={m.engSummaryT}>{summary.headline}</Text>
                {summary.sub ? <Text style={m.engSummarySub}>{summary.sub}</Text> : null}
              </View>
              {summary.overridable ? <Text style={m.engMore}>更改 ›</Text> : null}
            </Pressable>
            {pickerOpen && summary.overridable ? (
              <View style={m.pickerBox}>
                {/* 第一层：跟随预置（默认）+ 目录引擎行 */}
                <Pressable
                  style={[m.engRow, engineSel === "auto" && m.engRowOn]}
                  accessibilityLabel="跟随预置（自动）"
                  onPress={() => {
                    setEngineSel("auto");
                    setModelSel(null);
                    void AsyncStorage.setItem("ccr_use_codex", "0");
                    setPickerOpen(false);
                  }}
                >
                  <View style={[m.engDot, { backgroundColor: c.faint }]} />
                  <View style={m.engMain}>
                    <Text style={[m.engName, engineSel === "auto" && m.engNameOn]}>跟随预置（自动）</Text>
                    <Text style={m.engSub}>
                      {presetEntry
                        ? `${roleCap(presetEntry.default_for_roles![0])} 预置 · ${engineLabelOf(presetEntry)}`
                        : "由 relay 按源默认解析"}
                    </Text>
                  </View>
                  {engineSel === "auto" ? <Text style={m.engCheck}>✓</Text> : null}
                </Pressable>
                {/* 旧 relay（无目录）记忆 codex 行：ccr_use_codex 取消入口不删（兼容
                    行为保留），目录升级后由完整清单取代 */}
                {!catalog && engineSel === "codex" ? (
                  <Pressable
                    style={[m.engRow, m.engRowOn]}
                    accessibilityLabel="Codex 记忆偏好"
                    onPress={() => {
                      setEngineSel("auto");
                      void AsyncStorage.setItem("ccr_use_codex", "0");
                      setPickerOpen(false);
                    }}
                  >
                    <View style={[m.engDot, { backgroundColor: ENGINE_ACCENT.codex }]} />
                    <View style={m.engMain}>
                      <Text style={[m.engName, m.engNameOn]}>Codex</Text>
                      <Text style={m.engSub}>记忆偏好（升级 relay 后可在目录中选择）</Text>
                    </View>
                    <Text style={m.engCheck}>✓</Text>
                  </Pressable>
                ) : null}
                {(catalog ?? []).map((e) => {
                  const block = engineSelectable(e);
                  const on = engineSel === e.id;
                  const accent = ENGINE_ACCENT[e.id] ?? c.faint;
                  const stateColor = c[ENGINE_STATE_COLOR[e.state]];
                  const caps = e.capabilities;
                  const capsText = caps
                    ? [caps.resume ? "可恢复" : null, caps.approval ? "审批交互" : null, caps.artifacts ? "输出物" : null].filter(Boolean).join(" · ") || ENGINE_PHRASES.basicExec
                    : null;
                  return (
                    <View key={e.id}>
                      <Pressable
                        style={[m.engRow, on && m.engRowOn, block ? { opacity: 0.45 } : null]}
                        disabled={!!block}
                        accessibilityLabel={`引擎 ${engineLabelOf(e)}，${ENGINE_STATE_LABEL[e.state]}${block ? `，不可选：${block}` : ""}`}
                        onPress={() => {
                          setEngineSel(e.id);
                          setModelSel(null); // 模型绑定引擎：换引擎模型重置
                          void AsyncStorage.setItem("ccr_use_codex", e.id === "codex" ? "1" : "0");
                          if (!e.models || !e.models.length) setPickerOpen(false); // 无模型清单一步完成
                        }}
                      >
                        <View style={[m.engDot, { backgroundColor: accent }]} />
                        <View style={m.engMain}>
                          <View style={m.engNameRow}>
                            <Text style={[m.engName, on && m.engNameOn]} numberOfLines={1}>{engineLabelOf(e)}</Text>
                            <Text style={[m.engState, { color: stateColor }]}>{ENGINE_STATE_LABEL[e.state]}</Text>
                          </View>
                          {capsText ? <Text style={m.engSub}>{capsText}</Text> : null}
                          {block ? <Text style={[m.engBlockT, { color: c.waiting }]}>不可选：{block}</Text> : null}
                        </View>
                        {on ? <Text style={m.engCheck}>✓</Text> : null}
                      </Pressable>
                      {/* 第二层：选定引擎的模型行（内联展开；无清单显「使用引擎默认」，
                          不冒充 SNAPSHOT.models——那是 Claude 旧回退清单） */}
                      {on ? (
                        <View style={m.modelBox}>
                          <Text style={m.modelHead}>模型</Text>
                          {(e.models ?? []).map((mo) => {
                            const mOn = modelSel === mo;
                            return (
                              <Pressable
                                key={mo}
                                style={[m.modelRow, mOn && m.modelRowOn]}
                                accessibilityLabel={`模型 ${mo}`}
                                onPress={() => {
                                  setModelSel(mo);
                                  setPickerOpen(false);
                                }}
                              >
                                <Text style={[m.modelT, mOn && m.modelTOn]} numberOfLines={1}>{mo}</Text>
                                {mOn ? <Text style={m.engCheck}>✓</Text> : null}
                              </Pressable>
                            );
                          })}
                          <Pressable
                            style={[m.modelRow, modelSel === null && m.modelRowOn]}
                            accessibilityLabel={ENGINE_PHRASES.engineDefaultModel}
                            onPress={() => {
                              setModelSel(null);
                              setPickerOpen(false);
                            }}
                          >
                            <Text style={[m.modelT, modelSel === null && m.modelTOn]}>{ENGINE_PHRASES.engineDefaultModel}</Text>
                            {modelSel === null ? <Text style={m.engCheck}>✓</Text> : null}
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
                {!catalog ? <Text style={m.permLine}>{ENGINE_PHRASES.legacyRelayHint}</Text> : null}
                {permLine ? <Text style={m.permLine}>权限 · {permLine}</Text> : null}
              </View>
            ) : null}
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
            {/* 75-E：原「用 Codex 引擎」checkbox 已被上方引擎/模型选择器取代（PM-75
                §7.4 产品入口迁移）——ccr_use_codex 记忆口径保留：开弹窗带入 engine=
                codex、选回 codex 写 1、改选/跟随预置写 0，兼容行为不删 */}
            <Pressable
              style={[m.createBtn, createFlight.size > 0 && m.createBtnBusy]}
              android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false }}
              onPress={create}
            >
              <Text style={m.createT}>{createFlight.size > 0 ? "启动中…" : "启动会话"}</Text>
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
  // 75-E 引擎/模型选择器：摘要行（大触控行，panel2 底同 input 材质）+ 紧凑浮层两层
  engSummary: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12,
    paddingVertical: 10, paddingHorizontal: 13,
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, borderRadius: 12,
  },
  engSummaryT: { color: c.text, fontSize: 13.5, fontWeight: "600", marginTop: 2 },
  engSummarySub: { color: c.working, fontSize: 11, marginTop: 2 },
  engMore: { color: c.brandA, fontSize: 13, fontWeight: "600" },
  pickerBox: { backgroundColor: c.panel2, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 5, marginBottom: 12 },
  engRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 9, paddingVertical: 9, borderRadius: 9 },
  engRowOn: { backgroundColor: c.tintSoft },
  engDot: { width: 7, height: 7, borderRadius: 4 },
  engMain: { flex: 1, minWidth: 0, gap: 1 },
  engNameRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  engName: { color: c.dim, fontSize: 13.5, fontWeight: "500", flexShrink: 1 },
  engNameOn: { color: c.brandA, fontWeight: "700" },
  engState: { fontSize: 10.5, fontWeight: "600", flexShrink: 0 },
  engSub: { color: c.faint, fontSize: 11 },
  engBlockT: { fontSize: 11, fontWeight: "500" },
  engCheck: { color: c.brandA, fontSize: 13, fontWeight: "700" },
  modelBox: { marginTop: 2, marginLeft: 24, marginBottom: 4, padding: 5, backgroundColor: c.panel, borderRadius: 9 },
  modelHead: { color: c.faint, fontSize: 10.5, fontWeight: "600", paddingHorizontal: 9, paddingTop: 4, paddingBottom: 2 },
  modelRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 7 },
  modelRowOn: { backgroundColor: c.tintSoft },
  modelT: { color: c.dim, fontSize: 12.5, flex: 1 },
  modelTOn: { color: c.brandA, fontWeight: "600" },
  permLine: { color: c.faint, fontSize: 10.5, paddingHorizontal: 9, paddingTop: 6 },
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
  createBtnBusy: { opacity: 0.6 },
  createT: { color: "#fff", fontSize: 15.5, fontWeight: "700" },
  cancel: { height: 42, marginTop: 8, alignItems: "center", justifyContent: "center" },
  cancelT: { color: c.dim, fontSize: 14 },
});
