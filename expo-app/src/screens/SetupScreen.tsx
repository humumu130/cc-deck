import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";
import { withA, type ThemeColors } from "../theme";
import { LogoMark } from "../brand";
import { useTheme, useThemeStyles } from "../theme-context";
import { store, useRelay, type ServerEntry } from "../store";
import { uuid } from "../fmt";
import { currentVersion } from "../updates";
import { useKbHeight } from "../kb";
import ScanScreen, { routeScanResult, type ScanResult } from "./ScanScreen";
import ImportPicker, { type ImportTarget } from "./ImportPicker";

interface Props {
  onClose?: () => void; // 有值 = 从主界面进入（可返回）
  editId?: string | null; // 编辑已有服务器（预填表单，保存=更新条目）
  initialScan?: boolean; // 从抽屉「扫码添加」进入：直接拉起扫码页
}

function hostOf(wsUrl: string): string {
  try {
    return new URL(wsUrl).host;
  } catch {
    return wsUrl;
  }
}

// 两种接入形态的地址占位（#406 纯远程添加云桥）：云桥置顶（人在外面也能配对），
// LAN 直连降为次要路径
const LAN_URL_DEFAULT = "ws://192.168.0.105:8787/ws";
const CLOUD_URL_DEFAULT = "wss://cc.humumu.online/cloud";

export default function SetupScreen({ onClose, editId, initialScan }: Props) {
  const { c } = useTheme();
  const s = useThemeStyles(makeStyles);
  const snap = useRelay();
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  // 接入形态（#406）：cloud=云桥地址+配对码（远程可用，默认选中），lan=同一 WiFi 直连
  const [kind, setKind] = useState<"cloud" | "lan">("cloud");
  const [wsUrl, setWsUrl] = useState(CLOUD_URL_DEFAULT);
  const [code, setCode] = useState("");
  const [advOpen, setAdvOpen] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // 扫码直连（#276）：initialScan（抽屉扫码入口）进页即开扫码；扫得连接码自动填表单，
  // 预览确认后仍走下方 add() 既有流程
  const [scanOpen, setScanOpen] = useState(!!initialScan);
  // 连接导入（ccdeck-import）：电脑端「分享连接」码扫入后弹 ImportPicker，选定条目
  // 由选择器向码中 rt 临时通道回发（本页表单不参与）
  const [importOpen, setImportOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<ImportTarget | null>(null);
  const tokenInputRef = useRef<TextInput>(null);
  // 状态行显示的主机名：发起连接时固化，不随表单后续编辑漂移
  const [connHost, setConnHost] = useState("");
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
  // 编辑模式：预填该服务器现有配置；纯云桥条目（地址=桥地址）按云桥形态预填
  useEffect(() => {
    if (!editId) return;
    void store.loadServers().then((list) => {
      const e = list.find((x) => x.id === editId);
      if (!e) return;
      setName(e.name);
      setWsUrl(e.wsUrl);
      setToken(e.token);
      setRemember(!!e.token);
      setKind(e.cloud && e.wsUrl === e.cloud.url ? "cloud" : "lan");
    });
  }, [editId]);
  // 配对完成后 store 已更新条目，这里同步刷新列表（显示 ☁ 徽标）
  useEffect(() => {
    void reload();
  }, [snap.cloudMsg]);

  // 返回键回到主界面（仅从 ⚙ 进入时；首次配置无路可退）——已并入 App.tsx
  // 顶层单订阅统一分发（#282），本组件不再自订 BackHandler

  const toggleRemember = () => {
    setRemember((v) => {
      void AsyncStorage.setItem("ccr_remember_token", v ? "0" : "1");
      return !v;
    });
  };

  // 形态分段切换：仅当地址还停在另一形态的默认占位时才替换成新占位，用户已输入的值不动
  const switchKind = (k: "cloud" | "lan") => {
    if (k === kind) return;
    setKind(k);
    setErr(null);
    setCode("");
    setWsUrl((u) =>
      u === (k === "cloud" ? LAN_URL_DEFAULT : CLOUD_URL_DEFAULT)
        ? k === "cloud" ? CLOUD_URL_DEFAULT : LAN_URL_DEFAULT
        : u,
    );
  };

  // 云桥形态提交（#406）：新增=凭 6 位配对码远程配对（pairViaBridge 链路，无需同一
  // WiFi）；编辑=填码则重新配对，留空则只改地址/名称/桥令牌（身份保留，不强制重新配对）
  const submitCloud = () => {
    const base = wsUrl.trim().replace(/\/+$/, "");
    const bt = token.trim();
    const cd = code.trim();
    if (!/^wss?:\/\//.test(base)) {
      setErr("云桥地址需以 ws:// 或 wss:// 开头");
      return;
    }
    const dup = servers.find((e) => e.wsUrl === base && e.id !== editId);
    if (editId && dup) {
      setErr(`此地址已保存（${dup.name || hostOf(base)}），去改那条或换个地址`);
      return;
    }
    if (cd && !/^\d{6,8}$/.test(cd)) {
      setErr("配对码为 6-8 位数字（电脑端 CC Deck 设置→relay 页领取）");
      return;
    }
    if (!editId && !cd) {
      setErr("请填写 8 位配对码（电脑端 CC Deck 设置→relay 页领取）");
      return;
    }
    setErr(null);
    setPairing(true);
    const fin = (e2: string | null) => {
      setPairing(false);
      if (e2) {
        setErr(e2);
        return;
      }
      void reload();
      if (onClose) onClose();
    };
    if (editId && !cd) {
      // 不填码的编辑：同步 cloud.url/token 随 wsUrl 更新，relayDev/relayPubkey/dev
      // 原样保留——换桥域名（如 ECS 直连地址换 Cloudflare wss）直接可用，无需重新配对
      const cur = servers.find((e) => e.id === editId);
      if (!cur?.cloud) {
        // 本就无云桥配置的条目改到云桥形态却不填码：无处可验身份，落库只会是死条目
        setErr("该服务器尚未配对云桥，请填配对码完成配对");
        return;
      }
      void store
        .updateServer(editId, {
          name: name.trim() || hostOf(base),
          wsUrl: base,
          token: bt,
          cloud: cur?.cloud ? { ...cur.cloud, url: base, token: bt } : null,
        })
        .then(
          () => fin(null),
          () => fin("保存失败，请重试"),
        );
      return;
    }
    void store.addCloudManual(base, bt, cd, editId ?? undefined).then(fin);
  };

  const submit = () => {
    if (pairing) return;
    if (kind === "cloud") {
      submitCloud();
      return;
    }
    if (editId) saveEdit();
    else add();
  };

  const add = () => {
    const base = wsUrl.trim().replace(/\/+$/, "");
    const tk = token.trim();
    if (!/^wss?:\/\//.test(base)) {
      setErr("地址需以 ws:// 或 wss:// 开头");
      return;
    }
    if (!tk) {
      setErr("请填写访问令牌");
      return;
    }
    const dup = servers.find((e) => e.wsUrl === base);
    setErr(null);
    setConnHost(hostOf(base));
    if (dup) {
      // 已保存过该地址：多为点选无令牌条目后补输令牌的场景，直接带令牌连它
      // （按「记住令牌」决定是否回写条目），别用"去点选"把用户锁进提示循环
      void store.connectServer({ ...dup, token: remember ? tk : "" }, tk).then(() => {
        setActiveId(dup.id);
        if (onClose) onClose();
      });
      return;
    }
    const entry: ServerEntry = {
      id: uuid(),
      name: name.trim() || hostOf(base),
      wsUrl: base,
      token: remember ? tk : "",   // 不记住：条目只存地址，令牌仅本次连接用
    };
    void store.connectServer(entry, tk).then(() => {
      setActiveId(entry.id);
      reload(); // 同步本地列表：连接失败停留本页时防重才有据可依
      if (onClose) onClose(); // 首次连接的导航由 App 在 connected 后接管
    });
  };

  const saveEdit = () => {
    const base = wsUrl.trim().replace(/\/+$/, "");
    if (!editId) return;
    if (!/^wss?:\/\//.test(base)) {
      setErr("地址需以 ws:// 或 wss:// 开头");
      return;
    }
    const dup = servers.find((e) => e.wsUrl === base && e.id !== editId);
    if (dup) {
      setErr(`此地址已保存（${dup.name || hostOf(base)}），去改那条或换个地址`);
      return;
    }
    setErr(null);
    const tk = token.trim();
    void store.updateServer(editId, {
      name: name.trim() || hostOf(base),
      wsUrl: base,
      // #22 改名保连接：表单 token 为空（未记住/未显示）时不再把存量令牌抹成空串——
      // 旧实现改名即断链（updateServer 见 token 变化触发带空令牌重连）
      ...(remember && tk ? { token: tk } : {}),
    }).then(() => {
      if (onClose) onClose();
    });
  };

  const connect = (e: ServerEntry) => {
    if (!e.token && !e.cloud) {
      // 没记令牌的 LAN 条目：预填表单让用户补输，聚焦令牌框直接唤起键盘。
      // 纯云桥条目（公共桥 token 留空）不进这里——cloud 配置即建连凭据，直接连
      setName(e.name);
      setKind("lan");
      setWsUrl(e.wsUrl);
      setToken("");
      setErr("该服务器未记住令牌，补输后点下方按钮连接");
      setTimeout(() => tokenInputRef.current?.focus(), 60);
      return;
    }
    setConnHost(hostOf(e.wsUrl));
    void store.connectServer(e).then(() => {
      setActiveId(e.id);
      if (onClose) onClose();
    });
  };

  const remove = (e: ServerEntry) => {
    void store.deleteServer(e.id).then(() => reload());
  };

  // 扫码结果分发（#325，#329 纠偏；与设置抽屉共用 ScanScreen.routeScanResult 同一条
  // 链路）：本页只注入表单语境的钩子——错误落到表单 err 行、连接/接入成功后刷新列表
  // 并关页、直连码同步回填表单（用户已手输名称则尊重，连接失败停留本页时不误导）
  const applyScan = (r: ScanResult) => {
    void routeScanResult(r, {
      onError: setErr,
      onDone: () => {
        void reload();
        if (onClose) onClose();
      },
      onImport: (t) => {
        setImportTarget(t);
        setImportOpen(true);
      },
      onDirect: (base, tk) => {
        setWsUrl(base);
        setToken(tk);
        setKind("lan"); // 直连码扫到的是 LAN 地址：表单形态随之对齐
        setErr(null);
        if (!name.trim()) setName(hostOf(base));
        return name.trim() || undefined; // 新条目名：表单已手输名称则尊重
      },
    });
  };

  // 云桥区块针对的服务器：编辑模式=被编辑的条目，否则=当前活动条目；配对走当前 LAN 连接，故要求该条目已激活
  const cloudEntry = editId ? servers.find((e) => e.id === editId) : servers.find((e) => e.id === activeId);
  const cloudReady = !!cloudEntry && cloudEntry.id === activeId && snap.connected && snap.channel === "lan";

  // ① 已配对标识：本地存有云桥身份（entry.cloud = rd/rk/dev）=「已配对 ✓」，无 =「未
  // 配对」——一眼知道自己要不要输码。relay 实测态叠加：unpaired（收到明确 pair_nack）
  // 时翻成「配对失效」，与本地存档区分（存档还在，但 relay 已不认）
  const srcState = new Map(snap.sources.map((x) => [x.id, x.state] as const));

  // ④ 连接失败反馈三态分流：connecting/reconnecting 是传输层问题（杀网/断桥），自动
  // 重试自愈，文案绝不提配对码；unpaired（relay 明确拒绝身份）才引导输码重新配对；
  // failNote（桥不可达/电脑端 relay 离线等诊断）优先透出
  const activeEntry = servers.find((e) => e.id === activeId);
  const connDotColor =
    snap.connState === "connecting" || snap.connState === "reconnecting" ? c.working : c.waiting;
  let connMain = "";
  let connSub: string | null = null;
  let connRetryable = false;
  if (snap.connState === "connecting") {
    connMain = `正在连接 ${connHost || hostOf(wsUrl)}…`;
  } else if (snap.connState === "reconnecting" || snap.connState === "offline") {
    connRetryable = true;
    connMain =
      snap.connState === "reconnecting"
        ? `连接失败，${snap.connText}`
        : "连接失败，即将自动重试";
    const bits: string[] = [];
    if (snap.failNote) bits.push(snap.failNote);
    bits.push(
      activeEntry?.cloud
        ? "已配对身份仍在，无需重新输码，恢复后自动连上"
        : "直连需与 PC 同一 WiFi，远程请用「云桥」方式接入",
    );
    connSub = bits.join("；");
  } else if (snap.connState === "unpaired") {
    connMain = "配对已失效：relay 不再认可这台手机的身份";
    connSub = `${snap.failNote ? `${snap.failNote}；` : ""}需重新配对——上方选「云桥 · 远程」，填电脑端 CC Deck 领取的新配对码后点「配对并连接」`;
  }

  return (
    <SafeAreaView style={s.safe} edges={onClose ? ["top"] : []}>
      <View style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ ...s.wrap, paddingBottom: 36 + kb }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={s.logo}>
            <LogoMark size={34} />
          </View>
          <Text style={s.h2}>CC Deck</Text>
          <Text style={s.ver}>v{currentVersion()}</Text>
          <Text style={s.sub}>{editId ? "编辑服务器配置" : "连接到 PC Relay"}</Text>

          {!editId ? (
            <Pressable
              style={s.scanRow}
              android_ripple={{ color: c.tintSoft, borderless: false }}
              onPress={() => setScanOpen(true)}
              accessibilityLabel="扫码自动填写地址与令牌"
            >
              <Text style={s.scanGlyph}>▣</Text>
              <Text style={s.scanT}>扫码添加</Text>
              <Text style={s.scanHint}>对准 PC 终端二维码，免手输</Text>
            </Pressable>
          ) : null}

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
                        {srcState.get(e.id) === "unpaired" ? (
                          <Text style={s.srvBadgeDead}>配对失效</Text>
                        ) : e.cloud ? (
                          <Text style={s.srvBadgeOk}>已配对 ✓</Text>
                        ) : (
                          <Text style={s.srvBadgeNo}>未配对</Text>
                        )}
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
                  style={[s.pairBtn, !cloudReady && s.pairBtnOff]}
                  disabled={snap.cloudBusy || !cloudReady}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 17 }}
                  onPress={() => void store.pairCloud()}
                >
                  <Text style={s.pairBtnT}>
                    {snap.cloudBusy ? "配对中…" : cloudEntry?.cloud ? "重新配对云桥" : "配对云桥"}
                  </Text>
                </Pressable>
                {cloudEntry?.cloud ? (
                  <Pressable
                    style={s.unbindBtn}
                    android_ripple={{ color: c.tintSoft, borderless: false, radius: 17 }}
                    onPress={() => void store.updateServer(cloudEntry.id, { cloud: null }).then(() => reload())}
                  >
                    <Text style={s.unbindT}>解绑</Text>
                  </Pressable>
                ) : null}
              </View>
              {snap.cloudMsg ? (
                <Pressable hitSlop={6} onPress={() => store.clearCloudMsg()}>
                  <Text style={s.pairMsg} numberOfLines={2}>{snap.cloudMsg}</Text>
                </Pressable>
              ) : !cloudReady ? (
                <Text style={s.pairHint}>{cloudEntry && cloudEntry.id !== activeId ? "该服务器未连接：先在列表中点选连接它（同一 WiFi 直连）再配对" : "云桥配对需先连接该服务器（同一 WiFi 直连）；不在同一网络时可用下方表单的云桥方式远程添加"}</Text>
              ) : null}
            </View>
          ) : null}

          <View style={s.field}>
            <Text style={s.label}>名称（可选）</Text>
            <TextInput
              style={s.input}
              value={name}
              onChangeText={setName}
              placeholder="我的电脑"
              placeholderTextColor={c.faint}
            />
          </View>
          {/* 形态分段（#406）：云桥置顶（人在外面也能配对），LAN 直连降为次要 */}
          <View style={s.segRow}>
            <Pressable
              style={[s.segBtn, kind === "cloud" && s.segBtnOn]}
              android_ripple={{ color: c.tintSoft, borderless: false }}
              onPress={() => switchKind("cloud")}
              accessibilityLabel="使用云桥远程接入"
            >
              <Text style={[s.segT, kind === "cloud" && s.segTOn]}>云桥 · 远程</Text>
            </Pressable>
            <Pressable
              style={[s.segBtn, kind === "lan" && s.segBtnOn]}
              android_ripple={{ color: c.tintSoft, borderless: false }}
              onPress={() => switchKind("lan")}
              accessibilityLabel="同一 WiFi 直连"
            >
              <Text style={[s.segT, kind === "lan" && s.segTOn]}>同一 WiFi 直连</Text>
            </Pressable>
          </View>

          <View style={s.field}>
            <Text style={s.label}>{kind === "cloud" ? "云桥地址" : "Relay 地址"}</Text>
            <TextInput
              style={[s.input, err && !/^wss?:\/\//.test(wsUrl.trim()) && s.inputErr]}
              value={wsUrl}
              onChangeText={(v) => { setWsUrl(v); setErr(null); }}
              placeholder={kind === "cloud" ? CLOUD_URL_DEFAULT : LAN_URL_DEFAULT}
              placeholderTextColor={c.faint}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
            />
          </View>
          {kind === "cloud" ? (
            <>
              <View style={s.field}>
                <Text style={s.label}>
                  {editId ? "配对码（留空 = 仅改地址，不重新配对）" : "配对码（电脑端 CC Deck 领取的 8 位码）"}
                </Text>
                <TextInput
                  style={[s.input, err && !editId && !/^\d{6,8}$/.test(code.trim()) && s.inputErr]}
                  value={code}
                  onChangeText={(v) => { setCode(v.replace(/\D/g, "").slice(0, 8)); setErr(null); }}
                  placeholder="8 位数字"
                  placeholderTextColor={c.faint}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  maxLength={8}
                />
              </View>
              <Pressable style={s.advRow} hitSlop={6} onPress={() => setAdvOpen((v) => !v)}>
                <Text style={s.advT}>{advOpen ? "▾" : "▸"} 高级（云桥令牌，公共桥留空）</Text>
              </Pressable>
              {advOpen ? (
                <View style={s.field}>
                  <TextInput
                    style={s.input}
                    value={token}
                    onChangeText={(v) => { setToken(v); setErr(null); }}
                    placeholder="桥 token（自家部署填，公共桥留空）"
                    placeholderTextColor={c.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    secureTextEntry
                  />
                </View>
              ) : null}
            </>
          ) : (
            <>
              <View style={s.field}>
                <Text style={s.label}>访问令牌</Text>
                <TextInput
                  ref={tokenInputRef}
                  style={[s.input, err && !token.trim() && s.inputErr]}
                  value={token}
                  onChangeText={(v) => { setToken(v); setErr(null); }}
                  placeholder="token"
                  placeholderTextColor={c.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  secureTextEntry
                />
              </View>
              <Pressable style={s.checkRow} onPress={toggleRemember} hitSlop={6}>
                <View style={[s.checkBox, remember && s.checkBoxOn]}>
                  {remember ? <Text style={s.checkT}>✓</Text> : null}
                </View>
                <Text style={s.checkLabel}>记住令牌（下次免输入）</Text>
              </Pressable>
            </>
          )}
          {err ? <Text style={s.errT}>{err}</Text> : null}
          <Pressable style={s.btn} android_ripple={{ color: "rgba(255,255,255,0.15)", borderless: false }} onPress={submit}>
            <LinearGradient colors={[c.brandA, c.brandB]} style={s.btnGrad}>
              <Text style={s.btnText}>
                {pairing
                  ? "配对中…"
                  : kind === "cloud"
                    ? editId
                      ? code.trim() ? "重新配对并保存" : "保存修改"
                      : "配对并连接"
                    : editId ? "保存修改" : servers.length > 0 ? "添加并连接" : "连接"}
              </Text>
            </LinearGradient>
          </Pressable>
          {/* 连接过程反馈（仅首次配置页；从主界面进入时后台重连循环不该误报）：host 固化
              于发起连接时。④ 三态分流——connecting/reconnecting 只报网络重试（含②手动
              重试钮），unpaired 才是配对引导；idle/online 无行 */}
          {!onClose && connMain ? (
            <View style={s.connCard}>
              <View style={s.connStatRow}>
                <View style={[s.connStatDot, { backgroundColor: connDotColor }]} />
                <Text style={s.connStatT} numberOfLines={3}>{connMain}</Text>
              </View>
              {connSub ? <Text style={s.connSubT} numberOfLines={3}>{connSub}</Text> : null}
              {connRetryable ? (
                <Pressable
                  style={s.retryBtn}
                  android_ripple={{ color: c.tintSoft, borderless: false, radius: 15 }}
                  accessibilityLabel="立即重试连接"
                  onPress={() => store.retryNow()}
                >
                  <Text style={s.retryBtnT}>立即重试</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <Text style={s.hint}>
            {kind === "cloud"
              ? "远程首选云桥：填桥地址 + 6 位配对码，无需与 PC 同一网络；同一 WiFi 下也可切「直连」"
              : `直连需手机与 PC 在同一 WiFi，地址填 PC 上的 ${LAN_URL_DEFAULT}；不在同一网络请用云桥`}
          </Text>
          {onClose ? (
            <Pressable style={s.back} android_ripple={{ color: c.tintSoft, borderless: false, radius: 20 }} onPress={onClose}>
              <Text style={s.backT}>返回</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
      <ScanScreen visible={scanOpen} onClose={() => setScanOpen(false)} onResult={applyScan} />
      <ImportPicker visible={importOpen} target={importTarget} onClose={() => setImportOpen(false)} />
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  wrap: { alignItems: "center", paddingTop: 72, paddingBottom: 36, paddingHorizontal: 28 },
  logo: {
    width: 64, height: 64, borderRadius: 19, alignItems: "center", justifyContent: "center", marginBottom: 16,
    backgroundColor: "#1D1726", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)",
  },
  h2: { color: c.text, fontSize: 21, fontWeight: "700" },
  // 品牌名下版本号小字（弱化灰），对齐副信息行的弱视觉语言
  ver: { color: c.faint, fontSize: 11, marginTop: 3 },
  sub: { color: c.dim, fontSize: 13, marginTop: 4, marginBottom: 24 },
  // 扫码添加入口行（#276）：左侧图标+主文案，右侧灰色提示；点击拉起全屏扫码
  scanRow: {
    flexDirection: "row", alignItems: "center", gap: 8, width: "100%", maxWidth: 340,
    marginBottom: 20, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 12,
    backgroundColor: c.panel, borderWidth: 1, borderColor: withA(c.brandA, 0.45),
    overflow: "hidden",
  },
  scanGlyph: { color: c.brandA, fontSize: 15, fontWeight: "700" },
  scanT: { color: c.brandA, fontSize: 13.5, fontWeight: "700" },
  scanHint: { flex: 1, color: c.faint, fontSize: 11, textAlign: "right" },
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
  // ① 配对状态徽标（替代旧 ☁ 图标，信息更明确）：已配对=绿 / 未配对=灰 / 配对失效=红
  srvBadgeOk: { color: c.done, fontSize: 10.5, fontWeight: "700" },
  srvBadgeNo: { color: c.faint, fontSize: 10.5, fontWeight: "600" },
  srvBadgeDead: { color: c.waiting, fontSize: 10.5, fontWeight: "700" },
  pairRow: { marginTop: 4, alignSelf: "flex-start", flexDirection: "row", gap: 8 },
  pairBtn: {
    paddingHorizontal: 16, paddingVertical: 7, borderRadius: 17, borderWidth: 1,
    borderColor: withA(c.brandA, 0.55), backgroundColor: withA(c.brandA, 0.06),
  },
  pairBtnOff: { borderColor: c.line, backgroundColor: "transparent" },
  pairBtnT: { color: c.dim, fontSize: 13, fontWeight: "600" },
  unbindBtn: {
    paddingHorizontal: 13, paddingVertical: 7, borderRadius: 17, borderWidth: 1,
    borderColor: c.line,
  },
  unbindT: { color: c.faint, fontSize: 13, fontWeight: "600" },
  pairMsg: { color: c.dim, fontSize: 12, marginTop: 8 },
  pairHint: { color: c.faint, fontSize: 12, marginTop: 8 },
  field: { width: "100%", maxWidth: 340, marginBottom: 12 },
  // 形态分段（#406）：云桥置顶 / LAN 直连次之——尺寸与 srvRow 圆角语言一致
  segRow: { flexDirection: "row", gap: 8, width: "100%", maxWidth: 340, marginBottom: 14 },
  segBtn: {
    flex: 1, paddingVertical: 9, borderRadius: 12, borderWidth: 1, borderColor: c.line,
    alignItems: "center", backgroundColor: c.panel2, overflow: "hidden",
  },
  segBtnOn: { borderColor: withA(c.brandA, 0.6), backgroundColor: withA(c.brandA, 0.1) },
  segT: { color: c.faint, fontSize: 13, fontWeight: "600" },
  segTOn: { color: c.brandA },
  advRow: { alignSelf: "flex-start", marginBottom: 10, paddingVertical: 2 },
  advT: { color: c.dim, fontSize: 12.5 },
  input: {
    backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, borderRadius: 12,
    paddingHorizontal: 13, paddingVertical: 11, color: c.text, fontSize: 15,
  },
  inputErr: { borderColor: withA(c.waiting, 0.6) },
  errT: { color: c.waiting, fontSize: 12.5, marginTop: 4, marginBottom: 6, alignSelf: "flex-start" },
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
  // ④ 连接反馈卡：主行（点+文案）+ 诊断副行 + 重试钮（reconnecting 态）
  connCard: { width: "100%", maxWidth: 340, marginTop: 12 },
  connStatRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  connStatDot: { width: 7, height: 7, borderRadius: 4 },
  connStatT: { flex: 1, color: c.dim, fontSize: 12.5, lineHeight: 18 },
  connSubT: { color: c.faint, fontSize: 11.5, lineHeight: 16, marginTop: 4, paddingLeft: 14 },
  // ② 手动重试钮：与 pairBtn 同形制（胶囊描边），amber 系呼应"重试"语义
  retryBtn: {
    marginTop: 8, alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 15, borderWidth: 1, borderColor: withA(c.working, 0.5),
    backgroundColor: withA(c.working, 0.08), overflow: "hidden",
  },
  retryBtnT: { color: c.working, fontSize: 12.5, fontWeight: "600" },
  back: { marginTop: 14, paddingHorizontal: 22, paddingVertical: 8, borderRadius: 20 },
  backT: { color: c.dim, fontSize: 14 },
});
