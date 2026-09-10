// #312 App 在线更新：GitHub Releases 查新版（24h 静默检查 + 关于弹窗手动检查，#313 迁入），
// 双源下载（ECS 镜像优先，GitHub asset 回落），安装交给系统安装器（APK 签名兜底）。
// 全链路静默容错：任何失败返回 null，不打扰用户。
// 在线更新三修（2026-09-09）：弹窗正文只渲染 manifest 中文特性摘要（GitHub body 降级为
// 「查看完整变更」链接）；下载收进模块级管理器——弹窗只是订阅者，关弹窗/息屏不中断，
// AppState active 自动续传 + 指数退避重试 + .part 断点续传（Range 206 才续，200 全量重下）。
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import { fgSupported, startForegroundService } from "./notify";

const GH_LATEST = "https://api.github.com/repos/humumu130/cc-deck/releases/latest";
// ECS 镜像：无 TLS 但仅作下载源之一，APK 完整性/签名校验由系统安装器兜底；
// 镜像文件可能滞后于 GitHub Release，下载失败自然回落 ghUrl
const ECS_MIRROR = "http://8.133.211.170:8888/cc-deck.apk";
// #29 国内加速：轻量版本清单双镜像（发版八步清单同步上传），检查秒回；
// api.github.com 国内慢/易超时——清单可达时整条检查链不出墙，GitHub API 仅兜底
const MANIFEST_URLS = [
  "https://cc.humumu.online/dl/latest.json",
  "http://8.133.211.170:8888/latest.json",
];
const GH_RELEASE_PAGE = "https://github.com/humumu130/cc-deck/releases/latest";

const KEY_LAST_CHECK = "cc_update_last_check";
const KEY_SKIPPED = "cc_update_skipped";
const CHECK_WINDOW_MS = 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 5000;

// #313 本版特性摘要（关于弹窗逐条展示 + 更新弹窗 manifest notes 缺失时兜底），随版本发布同步维护。
// 措辞纪律（2026-09-10）：UI/文案类小调整合并为一条「UI 与文案优化」，不逐条铺陈
export const VERSION_NOTES: string[] = [
  "多台电脑并存：扫码接入新电脑不再影响原有连接",
  "列表信息行精简，界面更清爽",
];

export type UpdateInfo = {
  version: string; // 不带 v 前缀
  notes: string; // manifest 中文特性摘要（latest.json notes；清单缺失走 GitHub 兜底时为空串）
  apkUrl: string; // ECS 镜像（下载首选）
  ghUrl: string; // GitHub asset 直链（清单路径拿不到，置空，下载回落时经 GH API 懒解析）
  fullUrl: string; // release 页（弹窗「查看完整变更」次级链接，正文不铺 changelog）
};

// manifest notes / release 摘要 → 弹窗特性条目：latest.json 摘要是单行中文分号串，
// 兼容换行/英文分号分隔；去行首项目符号与行尾句号，最多 8 条防溢出
export function noteLines(notes: string): string[] {
  return notes
    .split(/[\n\r]+|[；;]/)
    .map((l) => l.trim().replace(/^[-*•·]\s*/, "").replace(/。+$/, "").trim())
    .filter((l) => l.length > 1)
    .slice(0, 8);
}

// #301 同款版本链：原生 versionName 优先（build.gradle），expoConfig 兜底
export function currentVersion(): string {
  return (Constants.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "").replace(/^v/, "");
}

// "v0.3.13" → [0,3,13]；非数字段按 0，预发布后缀（-beta 等）忽略
function parseSemver(v: string): number[] {
  const parts = v.replace(/^v/, "").split(/[.-]/).slice(0, 3);
  return parts.map((p) => Number(p.replace(/\D.*/, "")) || 0);
}

export function isNewer(remote: string, local: string): boolean {
  const r = parseSemver(remote);
  const l = parseSemver(local);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) !== (l[i] ?? 0)) return (r[i] ?? 0) > (l[i] ?? 0);
  }
  return false;
}

// 上次检查时间距今满 24h 才允许静默检查（手动检查不受此限）
export async function shouldAutoCheck(): Promise<boolean> {
  try {
    const last = Number((await AsyncStorage.getItem(KEY_LAST_CHECK)) ?? 0);
    return Date.now() - last >= CHECK_WINDOW_MS;
  } catch {
    return false;
  }
}

// "忽略此版"：记版本号，静默检查发现同版不再弹横幅（抽屉手动检查照常回结果）
export async function getSkippedVersion(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEY_SKIPPED);
  } catch {
    return null;
  }
}

export async function skipVersion(v: string): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_SKIPPED, v);
  } catch {}
}

// 查 GitHub 最新 release。无新版 / 无网络 / 无 APK asset / 解析失败一律返回 null。
// 只要拿到了 HTTP 响应（含 4xx/5xx）就记检查时间——网络本身通，没必要下次启动再撞
// 轻量清单检查：任一镜像可达即用（CF 域 TLS 最快，ECS 8888 兜底）。
// 清单version≤本地 → 直接 null（无新版场景同样秒回，不再撞 GitHub 超时）
async function checkManifest(): Promise<UpdateInfo | null | "miss"> {
  for (const url of MANIFEST_URLS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      let res: Response;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) continue;
      const m = (await res.json()) as { version?: string; notes?: string };
      const version = (m.version ?? "").replace(/^v/, "");
      if (!version) continue;
      if (!isNewer(version, currentVersion())) return null;
      return {
        version,
        notes: String(m.notes ?? "").slice(0, 500).trim(),
        apkUrl: ECS_MIRROR,
        ghUrl: "", // 清单不带 asset 直链；ECS 失败时 resolveGhAsset 懒解析
        fullUrl: GH_RELEASE_PAGE,
      };
    } catch {
      continue;
    }
  }
  return "miss"; // 双清单都不可达 → 走 GitHub API 兜底
}

export async function checkUpdate(): Promise<UpdateInfo | null> {
  // #29 清单优先：国内秒级；拿不到才落 GitHub（原路径原样保留为兜底）
  const fast = await checkManifest();
  if (fast !== "miss") return fast;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(GH_LATEST, {
        headers: { Accept: "application/vnd.github+json" },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    void AsyncStorage.setItem(KEY_LAST_CHECK, String(Date.now())).catch(() => {});
    if (!res.ok) return null;
    const rel = (await res.json()) as {
      tag_name?: string;
      assets?: { browser_download_url?: string }[];
    };
    const version = (rel.tag_name ?? "").replace(/^v/, "");
    if (!version || !isNewer(version, currentVersion())) return null;
    const apk = (rel.assets ?? []).find((a) => (a.browser_download_url ?? "").endsWith(".apk"));
    if (!apk?.browser_download_url) return null;
    return {
      version,
      notes: "", // GitHub body 是提交式长 changelog + 资产链接，不进弹窗正文；完整变更走 fullUrl
      apkUrl: ECS_MIRROR,
      ghUrl: apk.browser_download_url,
      fullUrl: GH_RELEASE_PAGE,
    };
  } catch {
    return null;
  }
}

// 轻量发布通道：抽屉手动检查发现新版 → 通知 Shell（App.tsx）弹更新横幅。
// Shell 挂载时订阅，卸载清空
let listener: ((info: UpdateInfo) => void) | null = null;

export function setUpdateListener(fn: ((info: UpdateInfo) => void) | null): void {
  listener = fn;
}

export function announceUpdate(info: UpdateInfo): void {
  listener?.(info);
}

// ==================== 下载管理器（模块级单例） ====================
// 弹窗只是快照订阅者：关闭弹窗下载继续（后台下载）；息屏/切后台中断后 AppState
// active 自动续传；失败指数退避自动重试；断点续传走 .part + Range（先探测 206/200，
// 200 = 服务端不支持 Range，弃 .part 全量重下——绝不把 200 当 206 追加污染文件）。
// 下载期间复用 relay 常驻前台服务保活（notify.startForegroundService 幂等 start）。

export type DlPhase = "idle" | "running" | "retrying" | "done" | "failed";

export type DownloadSnapshot = {
  version: string;
  phase: DlPhase;
  bytes: number; // 已落盘字节（.part / 完成包大小；弹窗重开据此接着显示进度）
  total: number; // 预期总字节；0=未知（进度条退化为已下 MB 数）
  attempt: number; // 自动重试轮次（1 起；0=首发/非重试态）
  installFail?: boolean; // #6 安装器拉起失败（典型：ColorOS 未授「安装未知应用」）——弹窗出指引
};

const KEY_DL_META = "cc_update_dl_meta";
const APK_PATH = FileSystem.cacheDirectory + "cc-deck-update.apk";
const PART_PATH = APK_PATH + ".part";
const APK_MIN_BYTES = 30_000_000; // #384 同款完整性体积下限（真包 ~90MB，HTML 假包过不去）
const MAX_TRIES = 8; // 全源总尝试上限，超出转 failed（手动重试清零）
const SWITCH_SOURCE_AFTER = 4; // 同源连续失败 N 次换源（跨源字节不可混续，弃 .part）
const STALL_GRACE_MS = 6000; // 回前台后仍无进度的宽限，超时判死取消重试

type DlMeta = { version: string; url: string; total: number; done?: boolean };
type TryResult = "ok" | "net" | "corrupt";

let dlListener: ((s: DownloadSnapshot | null) => void) | null = null;
let phase: DlPhase = "idle";
let version = "";
let bytes = 0;
let total = 0;
let attempt = 0;
let meta: DlMeta | null = null; // .part 归属（版本+源+总量），随进度落盘
let running = false;
let launched = false; // 本次 done 是否已自动拉过安装器（重启恢复的 done 不自动拉）
let gen = 0; // 代数计数：取消/换目标时 +1，旧循环在每个 await 后自查退出
let nextInfo: UpdateInfo | null = null; // 运行中收到新目标：旧循环退出后自动接续
let currentTask: ReturnType<typeof FileSystem.createDownloadResumable> | null = null;
let lastProgressAt = 0;
let lastEmitAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let expedite: (() => void) | null = null; // 退避等待的提前唤醒（解锁即重试）
let appStateHooked = false;
let ghAssetCache: string | null = null;
let installFail = false; // #6 安装器拉起失败标记（catch 静默是 0.4.4 卡 100% 无后续的根因之一）

function snapshot(): DownloadSnapshot | null {
  if (phase === "idle" || !version) return null;
  return { version, phase, bytes, total, attempt, ...(installFail ? { installFail: true } : {}) };
}

function emit(): void {
  dlListener?.(snapshot());
}

// 进度事件原生侧 ~100ms 一发，UI 刷新再压到 ~300ms 一帧
function emitProgress(): void {
  const now = Date.now();
  if (now - lastEmitAt < 300) return;
  lastEmitAt = now;
  emit();
}

export function getDownloadSnapshot(): DownloadSnapshot | null {
  return snapshot();
}

export function setDownloadListener(fn: ((s: DownloadSnapshot | null) => void) | null): void {
  dlListener = fn;
}

async function persistMeta(url: string, done = false): Promise<void> {
  meta = { version, url, total, done };
  try {
    await AsyncStorage.setItem(KEY_DL_META, JSON.stringify(meta));
  } catch {}
}

async function clearFiles(): Promise<void> {
  meta = null;
  try {
    await AsyncStorage.removeItem(KEY_DL_META);
  } catch {}
  try {
    await FileSystem.deleteAsync(PART_PATH, { idempotent: true });
  } catch {}
  try {
    await FileSystem.deleteAsync(APK_PATH, { idempotent: true });
  } catch {}
}

// Range 支持探测：GET + Range: bytes=0-0（1 字节），响应头到达即 abort——无 Range 的
// 服务器会答 200 并开始灌整包，abort 挡在头部阶段不进内存。
// 206=支持续传 / 200=不支持（全量重下）/ "net"=探测本身失败（按网络问题退避重试）
function probeRangeSupport(url: string): Promise<boolean | "net"> {
  return new Promise((resolve) => {
    let settled = false;
    let xhr: XMLHttpRequest | null = null;
    const finish = (v: boolean | "net") => {
      if (settled) return;
      settled = true;
      try {
        xhr?.abort();
      } catch {}
      resolve(v);
    };
    try {
      xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.setRequestHeader("Range", "bytes=0-0");
      xhr.onreadystatechange = () => {
        if (xhr && xhr.readyState === 2) finish(xhr.status === 206);
      };
      xhr.onerror = () => finish("net");
      xhr.ontimeout = () => finish("net");
      xhr.send();
    } catch {
      finish("net");
    }
    setTimeout(() => finish("net"), 6000);
  });
}

// 完整性校验（#384 同款 ZIP magic + 体积下限 + 总量精确比对）→ .part 转正 APK → done
async function verifyAndFinalize(url: string): Promise<boolean> {
  const finfo = await FileSystem.getInfoAsync(PART_PATH);
  const size = finfo.exists ? (finfo.size ?? 0) : 0;
  const head =
    size > 4
      ? await FileSystem.readAsStringAsync(PART_PATH, { length: 4, encoding: FileSystem.EncodingType.Base64 })
      : "";
  if (!finfo.exists || size < APK_MIN_BYTES || (total > 0 && size !== total) || head !== "UEsDBg==") {
    await FileSystem.deleteAsync(PART_PATH, { idempotent: true });
    total = 0;
    return false;
  }
  await FileSystem.deleteAsync(APK_PATH, { idempotent: true });
  await FileSystem.moveAsync({ from: PART_PATH, to: APK_PATH });
  await persistMeta(url, true);
  bytes = size;
  total = size;
  phase = "done";
  installFail = false; // 新一轮完成：清上一轮的失败标记
  emit();
  void maybeLaunchInstaller();
  return true;
}

async function tryDownload(url: string, myGen: number): Promise<TryResult> {
  // .part 归属校验：版本/源任一不匹配（换目标/换源）→ 弃之重来
  let partSize = 0;
  const pinfo = await FileSystem.getInfoAsync(PART_PATH);
  if (pinfo.exists) partSize = pinfo.size ?? 0;
  if (partSize > 0 && (meta?.version !== version || meta?.url !== url)) {
    await FileSystem.deleteAsync(PART_PATH, { idempotent: true });
    partSize = 0;
    total = 0;
  }

  if (partSize > 0 && total > 0 && partSize >= total) {
    // .part 已达预期总量（上次恰在收尾后崩溃）：直接校验转正，免再请求
    if (await verifyAndFinalize(url)) return "ok";
  } else if (partSize > 0 && total > 0) {
    // 断点续传：半截 .part → 先探测 Range。206 → 从 partSize 续；
    // 200 → 服务端不支持 Range，弃 .part 全量重下（进度从头）
    const probe = await probeRangeSupport(url);
    if (myGen !== gen) return "net";
    if (probe === "net") return "net";
    if (probe) {
      phase = "running";
      bytes = partSize;
      emit();
      // createDownloadResumable 的 resumeData=已下字节数：原生层发 Range: bytes=N- 并追加写
      return await runResumable(url, String(partSize), myGen);
    }
    await FileSystem.deleteAsync(PART_PATH, { idempotent: true });
    partSize = 0;
    total = 0;
  }
  phase = "running";
  bytes = 0;
  emit();
  return await runResumable(url, undefined, myGen);
}

async function runResumable(url: string, resumeData: string | undefined, myGen: number): Promise<TryResult> {
  if (total <= 0) total = meta?.total ?? 0;
  lastProgressAt = Date.now();
  emit();
  const task = FileSystem.createDownloadResumable(
    url,
    PART_PATH,
    {},
    (d) => {
      bytes = Math.floor(d.totalBytesWritten);
      if (d.totalBytesExpectedToWrite > 0 && d.totalBytesExpectedToWrite !== total) {
        total = Math.floor(d.totalBytesExpectedToWrite);
        void persistMeta(url);
      }
      lastProgressAt = Date.now();
      // 后台期间事件不派发（expo 文档明示），前台才刷 UI；字节/看门狗时钟照常记账
      if (AppState.currentState === "active") emitProgress();
    },
    resumeData
  );
  currentTask = task;
  let result: Awaited<ReturnType<typeof task.downloadAsync>>;
  try {
    result = await task.downloadAsync();
  } catch {
    return "net";
  } finally {
    if (currentTask === task) currentTask = null;
  }
  if (myGen !== gen) return "net";
  if (!result) return "net"; // 被取消（看门狗掐死停滞任务/换目标）
  const status = result.status ?? 0;
  // 续传请求却被答 200：服务端无视 Range（探测后被替换/代理改写）——原生层已把整包
  // 追加进 .part，文件已污染。弃之重来，绝不把 200 当 206
  if (resumeData && status !== 206) {
    await FileSystem.deleteAsync(PART_PATH, { idempotent: true });
    total = 0;
    return "corrupt";
  }
  if (status !== 200 && status !== 206) return "net";
  if (await verifyAndFinalize(url)) return "ok";
  return "corrupt";
}

function backoffDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      expedite = null;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      resolve();
    };
    expedite = fin;
    retryTimer = setTimeout(fin, ms);
  });
}

// 清单路径 ghUrl 为空：ECS 源失败后经 GH API 懒解析 asset 直链（成功即缓存）
async function resolveGhAsset(): Promise<string | null> {
  if (ghAssetCache) return ghAssetCache;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(GH_LATEST, {
        headers: { Accept: "application/vnd.github+json" },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const rel = (await res.json()) as { assets?: { browser_download_url?: string }[] };
    ghAssetCache = (rel.assets ?? []).find((a) => (a.browser_download_url ?? "").endsWith(".apk"))?.browser_download_url ?? null;
    return ghAssetCache;
  } catch {
    return null;
  }
}

async function attemptLoop(info: UpdateInfo, myGen: number): Promise<void> {
  // 优先续用 .part 归属源（meta 落盘时记的 url），否则首选 ECS 镜像
  let url = meta?.version === version && meta?.url ? meta.url : info.apkUrl;
  let sourceFails = 0;
  for (let tries = 1; tries <= MAX_TRIES; tries++) {
    const r = await tryDownload(url, myGen);
    if (myGen !== gen) return; // 已取消/换目标
    if (r === "ok") return;
    sourceFails++;
    // 同源连败 → 换 GitHub asset（跨源字节不可混续：弃 .part 全量重来）
    if (sourceFails >= SWITCH_SOURCE_AFTER && tries < MAX_TRIES) {
      const gh = info.ghUrl || (await resolveGhAsset());
      if (myGen !== gen) return;
      if (gh && gh !== url) {
        url = gh;
        sourceFails = 0;
        meta = null; // tryDownload 的归属校验兜底删 .part，这里同步清引用与总量
        try {
          await FileSystem.deleteAsync(PART_PATH, { idempotent: true });
        } catch {}
        total = 0;
      } else {
        sourceFails = 0; // 无备用源：留在当前源把剩余次数用完
      }
    }
    if (tries >= MAX_TRIES) break;
    attempt = tries;
    phase = "retrying";
    emit();
    await backoffDelay(Math.min(30000, 2000 * 2 ** (tries - 1))); // 2s/4s/8s/…封顶 30s
    if (myGen !== gen) return;
  }
  phase = "failed";
  emit();
}

function bumpGen(): void {
  gen++;
  try {
    currentTask?.cancelAsync().catch(() => {});
  } catch {}
  if (expedite) expedite();
}

async function runLoop(info: UpdateInfo): Promise<void> {
  if (running) {
    // 已在跑：同版不管（弹窗重开/重复点按），异版排队换目标
    if (version !== info.version) {
      nextInfo = info;
      bumpGen();
    }
    return;
  }
  running = true;
  const myGen = ++gen;
  try {
    version = info.version;
    attempt = 0;
    launched = false;
    if (total <= 0 && meta?.version === version) total = meta.total;
    phase = "running";
    emit();
    // 下载保活：复用 relay 常驻前台服务（start 幂等——服务已在跑只是再走一次
    // onStartCommand，进程优先级/FGS 不变；下载独立于 relay 连接态，没连上也照起）
    if (fgSupported()) startForegroundService();
    await attemptLoop(info, myGen);
  } finally {
    running = false;
    if (nextInfo) {
      const ni = nextInfo;
      nextInfo = null;
      void runLoop(ni);
    }
  }
}

// 弹窗「立即更新」：同版在跑则继续，异版换目标，空闲则全新开始
export function startDownload(info: UpdateInfo): void {
  hookAppState();
  void runLoop(info);
}

// 弹窗「重试更新」（failed 后手动）：清重试计数再来
export function retryDownload(info: UpdateInfo): void {
  hookAppState();
  if (running) return;
  void runLoop(info);
}

// 弃下载（忽略此版等）：取消在跑任务、清 .part/安装包/meta（loop 侧经代数自查退出）
export function cancelDownload(): void {
  nextInfo = null;
  bumpGen();
  phase = "idle";
  version = "";
  bytes = 0;
  total = 0;
  attempt = 0;
  installFail = false;
  emit();
  void clearFiles();
}

async function doLaunchInstaller(): Promise<boolean> {
  // #6：安装器拉起失败不再静默——ColorOS 未授「安装未知应用」时意图被系统拦掉，
  // 旧实现 catch{} 吞掉后用户只见 100% 无后续。失败置标记，弹窗给指引+去授权入口
  try {
    const uri = await FileSystem.getContentUriAsync(APK_PATH);
    // flags:1 = FLAG_GRANT_READ_URI_PERMISSION，授权系统安装器读缓存里的 content:// 文件
    await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
      data: uri,
      type: "application/vnd.android.package-archive",
      flags: 1,
    });
    installFail = false;
  } catch {
    installFail = true;
  }
  emit();
  return !installFail;
}

// 「去授权」直达系统设置页（安装未知应用 · 本应用）：失败兜底打开应用详情页
export async function openInstallPermSettings(): Promise<void> {
  try {
    await IntentLauncher.startActivityAsync("android.settings.MANAGE_UNKNOWN_APP_SOURCES", {
      data: "package:com.humumu.ccwatch",
    });
  } catch {
    try {
      await IntentLauncher.startActivityAsync("android.settings.APPLICATION_DETAILS_SETTINGS", {
        data: "package:com.humumu.ccwatch",
      });
    } catch {}
  }
}

// 手动拉安装器（弹窗「立即安装」）：无条件尝试（自动拉过一次后仍可再拉）
export function launchInstaller(): void {
  if (phase !== "done") return;
  launched = true;
  void doLaunchInstaller();
}

// 自动拉安装器：仅在 App 前台时（Android 10+ 后台禁止启动 Activity）；
// 完成时在后台没拉成的，等回前台（onAppActive）补拉。失败回滚 launched 允许下轮
// 前台再试（doLaunchInstaller 已置 installFail 供弹窗指引）
async function maybeLaunchInstaller(): Promise<void> {
  if (phase !== "done" || launched) return;
  if (AppState.currentState !== "active") return;
  launched = true;
  if (!(await doLaunchInstaller())) launched = false;
}

// 解锁/回前台三件事：done 未拉成的安装器补拉；退避等待中的立即重试；
// 下载停滞（息屏后 Doze 掐网络的典型症状——进度事件停更）→ 宽限后取消按网络失败重试
function onAppActive(): void {
  if (phase === "done") void maybeLaunchInstaller();
  if (expedite) expedite();
  if (running && currentTask) {
    setTimeout(() => {
      if (
        AppState.currentState === "active" &&
        running &&
        currentTask &&
        Date.now() - lastProgressAt > STALL_GRACE_MS
      ) {
        try {
          currentTask.cancelAsync().catch(() => {});
        } catch {}
      }
    }, STALL_GRACE_MS);
  }
}

function hookAppState(): void {
  if (appStateHooked) return;
  appStateHooked = true;
  AppState.addEventListener("change", (st) => {
    if (st === "active") onAppActive();
  });
}

// App 启动调用：恢复上次未完的更新下载（.part + meta 已落盘）。
// 中断态自动续传（用户点过「立即更新」，续传无需再确认）；done 态只恢复快照，
// 不自动弹安装器（避免每次开 App 都被拽进安装流程），等用户在弹窗点「立即安装」
export async function resumePendingDownload(): Promise<void> {
  hookAppState();
  try {
    const raw = await AsyncStorage.getItem(KEY_DL_META);
    if (!raw) return;
    const m = JSON.parse(raw) as Partial<DlMeta>;
    if (!m.version || !m.url) return;
    if (m.done) {
      const a = await FileSystem.getInfoAsync(APK_PATH);
      if (a.exists && (a.size ?? 0) >= APK_MIN_BYTES) {
        version = m.version;
        total = m.total || (a.size ?? 0);
        bytes = a.size ?? 0;
        phase = "done";
        launched = true; // 重启恢复的不自动拉
        emit();
        return;
      }
      await clearFiles();
      return;
    }
    const p = await FileSystem.getInfoAsync(PART_PATH);
    if (!p.exists || (p.size ?? 0) <= 0) {
      await clearFiles();
      return;
    }
    version = m.version;
    total = m.total ?? 0;
    bytes = p.size ?? 0;
    meta = { version: m.version, url: m.url, total: m.total ?? 0 };
    void runLoop({ version: m.version, notes: "", apkUrl: m.url, ghUrl: "", fullUrl: GH_RELEASE_PAGE });
  } catch {}
}
