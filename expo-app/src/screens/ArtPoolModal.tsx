// #72 E 线 产物中心（全局产物池 A 单源）expo 池视图。
// 规格对表（docs/reviews/2026-10-06-72w0-worker-h.md + W 线 03e8fcd diff）：
// - 数据源 = 池 A 单源（/api/artifacts），与会话账 deliverables 正交、禁双源拼装；
// - 降级 = 探测 no 的源不出节（入口/视图整体隐藏，下线不灰置）；空池 = 空态文案；
// - 动作 = HTTP 直取（store.fetchPoolFile，token 封在 store 不进 UI），预览复用
//   DetailScreen 的 ArtView（mime 分级同尺）——404 显「文件已不存在（可能已被清理）」
//   （web W 线同文案），不假预览；
// - unknown 护栏 = 名字客户端先拒在 store（poolNameOk），本组件不接畸形名。
// 形态差异（备案）：web = 侧栏常驻钮 + 详情列第四态单源视图；expo 无列形态 →
// 列表页统计行常驻胶囊（入口①）+ 详情页可达行（入口②），池视图 = 底部弹层，
// 多源可用时按源分节（web 单窗口单源无此形态）。
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { useTheme, useThemeStyles } from "../theme-context";
import type { ThemeColors } from "../theme";
import { store, useRelay, type SourceStatus } from "../store";
import { toB64 } from "../e2e";
import { artDataOf, artPoolGate, artPoolGroupsOf, fmtArtSize, fmtArtTime, type ArtPoolItem } from "../artpool";
import { ArtView, type ArtViewData } from "./DetailScreen";

type Props = { visible: boolean; onClose: () => void };

export default function ArtPoolModal({ visible, onClose }: Props) {
  const { c } = useTheme();
  const d = useThemeStyles(makeStyles);
  const snap = useRelay();
  const [items, setItems] = useState<Record<string, ArtPoolItem[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fold, setFold] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<ArtViewData | null>(null);
  const [pulling, setPulling] = useState<string | null>(null); // 正在拉取的文件名（行内转圈）
  // 三重门过的源（探测 yes && deliverables && online）——降级面：no/pending 源不出节
  const poolSources = snap.sources.filter(artPoolGate);
  // 打开即重拉保新鲜（web openArtPool「每次进入重拉」同语义）：并发重拉各源，
  // 任一失败显错误条但不清其他源的面（瞬时失败不推翻入口可见性）
  useEffect(() => {
    if (!visible) {
      setErr(null);
      setView(null);
      return;
    }
    let dead = false;
    setBusy(true);
    const srcs = snap.sources.filter(artPoolGate);
    Promise.all(
      srcs.map((s) =>
        store
          .refreshArtPool(s.id)
          .then((list) => ({ id: s.id, list }))
          .catch((e) => ({ id: s.id, err: e instanceof Error ? e.message : String(e) })),
      ),
    ).then((rs) => {
      if (dead) return;
      const next: Record<string, ArtPoolItem[]> = {};
      let firstErr: string | null = null;
      for (const r of rs) {
        if ("list" in r && r.list) next[r.id] = r.list;
        else if ("err" in r && r.err && !firstErr) firstErr = r.err;
      }
      setItems(next);
      setErr(firstErr);
      setBusy(false);
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  // 行点 = 拉取 + mime 分级 + ArtView 全屏预览（分享/浏览器在 ArtView 头部，既有链）
  const openItem = async (s: SourceStatus, name: string) => {
    if (pulling) return;
    setPulling(name);
    setErr(null);
    try {
      const { u8, mime } = await store.fetchPoolFile(s.id, name);
      // uri 仅 img/sys 两级使用（分级后 sys 会另行落盘外开）；池拉取无预落盘 uri，
      // img 直接以 data 形态不可行（RN Image 需 uri）——img/sys 统一先落 cache 盘再分级
      setView(await poolArtView(s.id, name, u8, mime));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPulling(null);
    }
  };
  const leaf = (name: string) => name.split("/").pop() || name;
  const renderItem = (s: SourceStatus, it: ArtPoolItem, i: number) => (
    <Pressable
      key={s.id + "|" + it.name}
      style={[d.row, i % 2 ? d.rowAlt : null]}
      android_ripple={{ color: c.tintSoft, borderless: false }}
      disabled={pulling === it.name}
      onPress={() => void openItem(s, it.name)}
      accessibilityLabel={`预览 ${leaf(it.name)}`}
    >
      <Text style={d.rowName} numberOfLines={1}>{leaf(it.name)}</Text>
      <View style={d.rowMeta}>
        {pulling === it.name ? <ActivityIndicator size="small" color={c.brandA} /> : null}
        <Text style={d.rowSize}>{fmtArtSize(it.size)}</Text>
        <Text style={d.rowTime}>{fmtArtTime(it.mtime)}</Text>
      </View>
    </Pressable>
  );
  const renderSource = (s: SourceStatus) => {
    const list = items[s.id] ?? s.artPoolData ?? [];
    const groups = artPoolGroupsOf(list);
    return (
      <View key={s.id}>
        {poolSources.length > 1 ? (
          <Text style={d.srcHead} numberOfLines={1}>{s.name}</Text>
        ) : null}
        {list.length === 0 ? (
          <Text style={d.empty}>{busy ? " " : "输出物目录是空的"}</Text>
        ) : (
          groups.map((g) =>
            g.dir === "" ? (
              g.items.map((it, i) => renderItem(s, it, i))
            ) : (
              <View key={s.id + "|d|" + g.dir}>
                <Pressable
                  style={d.dirRow}
                  android_ripple={{ color: c.tintSoft, borderless: false }}
                  onPress={() => setFold((v) => ({ ...v, [s.id + "|" + g.dir]: !(v[s.id + "|" + g.dir] ?? false) }))}
                  accessibilityLabel={fold[s.id + "|" + g.dir] ? `收起目录 ${g.dir}` : `展开目录 ${g.dir}，${g.items.length} 个文件`}
                >
                  <Text style={d.dirArrow}>{fold[s.id + "|" + g.dir] ? "▾" : "▸"}</Text>
                  <Text style={d.dirName} numberOfLines={1}>{g.dir}</Text>
                  <Text style={d.dirN}>{g.items.length}</Text>
                </Pressable>
                {/* 目录默认收起（机器级扫描可能整目录几十个文件，全开易淹没）；
                    开合纯呈现态不落盘 */}
                {fold[s.id + "|" + g.dir] ? g.items.map((it, i) => renderItem(s, it, i)) : null}
              </View>
            ),
          )
        )}
      </View>
    );
  };
  const open = visible;
  return (
    <>
      <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
        <Pressable style={d.mask} onPress={onClose}>
          <Pressable style={d.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={d.head}>
              <Text style={d.title}>输出物</Text>
              <Text style={d.sub}>{poolSources.length > 0 ? `${poolSources.length} 台设备的全局目录` : "暂无可用的输出物目录"}</Text>
              <Pressable hitSlop={10} accessibilityLabel="关闭输出物目录" onPress={onClose}>
                <Text style={d.close}>×</Text>
              </Pressable>
            </View>
            {err ? <Text style={d.errT}>{err}</Text> : null}
            <ScrollView style={d.list} contentContainerStyle={{ paddingBottom: 24 }}>
              {poolSources.length === 0 ? (
                <Text style={d.empty}>探测中的设备没有可用的输出物目录（仅同网直连可用）</Text>
              ) : busy && poolSources.every((s) => !(items[s.id] ?? s.artPoolData ?? []).length) ? (
                <View style={d.busyWrap}>
                  <ActivityIndicator size="small" color={c.brandA} />
                </View>
              ) : (
                poolSources.map(renderSource)
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
      {/* 预览全屏层（DetailScreen 既有 ArtView 复用：mime 分级/分享/浏览器全链）。
          受控常驻渲染（#216 同款修：v 空态=关，勿改回条件挂卸） */}
      <ArtView v={view} onClose={() => setView(null)} />
    </>
  );
}

// 池文件 → ArtViewData：img/sys 两级需要本地 uri（RN Image 外开均走文件系统），
// 落 cache 临时目录干净名（分享链 shareArtView 会再复制，这里允许前缀名——池文件
// 无会话账 cacheKey，用源id|名字哈希形态）。文本级不落盘直接内存
async function poolArtView(sid: string, name: string, u8: Uint8Array, mime: string): Promise<ArtViewData> {
  const kind0 = mime.startsWith("image/") || !(mime.startsWith("text/") || mime === "text/html" || mime === "text/markdown" || mime === "application/json");
  if (!kind0) return artDataOf(u8, mime, name, ""); // 文本级：无 uri
  const safe = `${sid}-${name}`.replace(/[\\/:*?"<>|]/g, "_").slice(-100) || "artifact";
  const uri = `${FileSystem.cacheDirectory ?? ""}pool-${safe}`;
  // base64 编码复用 e2e.toB64（DetailScreen fromB64 反向同源，禁重写）
  await FileSystem.writeAsStringAsync(uri, toB64(u8), { encoding: FileSystem.EncodingType.Base64 });
  return artDataOf(u8, mime, name, uri);
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    mask: { flex: 1, backgroundColor: "rgba(0,0,0,.45)", justifyContent: "flex-end" },
    sheet: {
      backgroundColor: c.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16,
      borderWidth: 1, borderColor: c.line, maxHeight: "82%",
    },
    head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line },
    title: { color: c.text, fontSize: 15, fontWeight: "700", flex: 1 },
    sub: { color: c.brandA, fontSize: 11, fontWeight: "600" },
    close: { color: c.faint, fontSize: 20, fontWeight: "600", paddingLeft: 6 },
    errT: { color: c.error, fontSize: 11.5, paddingHorizontal: 14, paddingTop: 8 },
    list: { paddingHorizontal: 14 },
    busyWrap: { alignItems: "center", paddingVertical: 32 },
    empty: { color: c.faint, fontSize: 12, textAlign: "center", paddingVertical: 32 },
    srcHead: { color: c.faint, fontSize: 10.5, fontWeight: "700", paddingTop: 14, paddingBottom: 4 },
    row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 9, borderRadius: 8, paddingHorizontal: 6 },
    rowAlt: { backgroundColor: c.tintSoft },
    rowName: { color: c.text, fontSize: 13, flex: 1, minWidth: 0 },
    rowMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
    rowSize: { color: c.faint, fontSize: 10.5, fontVariant: ["tabular-nums"] },
    rowTime: { color: c.faint, fontSize: 10.5 },
    dirRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 6, marginTop: 4 },
    dirArrow: { color: c.brandA, fontSize: 12, width: 12 },
    dirName: { color: c.text, fontSize: 12.5, fontWeight: "700", flex: 1 },
    dirN: { color: c.faint, fontSize: 10.5 },
  });
