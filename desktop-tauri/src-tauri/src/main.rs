// CC Deck 桌面壳（Tauri 2）：加载打包内嵌的 web-console（frontendDist 指向 ../../web-console，
// 构建时整个目录烙进二进制），默认连本机 relay。与 desktop/（Electron 壳）并行共存，
// 产物名带 -tauri 区分。
//
// 与 Electron 版（desktop/main.js）的对应关系与取舍：
// - 窗口参数：1200×800 / min 960×640 / 标题 CC Deck，在 tauri.conf.json 声明（create:false），
//   由 setup 用 from_config 接管创建——为的是挂 initialization_script（conf 不支持该字段）。
// - relay 探测：页面在 Tauri 下运行于 http://tauri.localhost 源，页面侧 fetch /local-info
//   会带该 Origin，进不了 relay 白名单（ws-server.ts hostTrusted 只认 localhost/127.0.0.1/
//   本机 LAN IP）→ 探测必须留在壳侧：本进程发请求不带 Origin，relay 走 Host 判定放行，
//   与 Electron 主进程同信任模型。经 initialization_script 注入 window.ccDeck.probeLocal
//   （与 Electron preload 同形），web-console/index.html 零改动即用。
// - 单实例：tauri-plugin-single-instance（须最先注册），二次启动回调里 show + focus 主窗口。
// - 托盘：TrayIconBuilder + muda 菜单（显示主窗口 / 分隔线 / 退出），双击托盘唤起；
//   关窗默认隐藏到托盘（quit 标志位放开）；托盘构建失败不致命——置 TRAY_OK=false，关窗直退。
// - 外链：target=_blank 在 WebView2 内默认无动作（wry 拒开新窗），initialization_script
//   捕获阶段拦截 a[href^=http]（#101 放宽：不再限定 target）+ window.open，http(s) 走
//   open_external 命令 → tauri-plugin-opener 唤系统浏览器；on_navigation 只放行
//   tauri.localhost 源，等价 Electron 的 will-navigate 白名单。#101：公司 Windows 实测
//   点击无反应（疑 initialization_script 在 WebView2 上未注入），页面层（web-console）
//   另有同款兜底拦截，两层以 defaultPrevented 互相去重。
// - 暂缺（与 Electron 的差异）：--smoke 冒烟模式（CI 侧用 Electron 包覆盖）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_opener::OpenerExt;

/// 托盘菜单“退出”置位（否则关窗一律隐藏到托盘）
static QUITTING: AtomicBool = AtomicBool::new(false);
/// 托盘是否建成：图标缺失等失败时关窗直退，不留“隐身无出口”状态
static TRAY_OK: AtomicBool = AtomicBool::new(false);
/// #8 呼出/收起快捷键当前注册态（换绑时先注销旧的；None=已注销）
static TOGGLE_SHORTCUT: std::sync::Mutex<Option<tauri_plugin_global_shortcut::Shortcut>> =
    std::sync::Mutex::new(None);
/// #19 默认呼出/收起键（2026-09-10 用户定）：网页侧可用 set_toggle_shortcut 改绑（localStorage 记忆）
const DEFAULT_TOGGLE_KEY: &str = "alt+d";

/// 页面启动前注入的桥（等价 desktop/preload.js）：probeLocal 优先走 window.ccDeck；
/// 外链兜底：捕获阶段拦 target=_blank 与 window.open，转交壳侧系统浏览器打开
const INIT_SCRIPT: &str = r##"
// W-MIG 种子恢复（置顶）：localStorage 为空（换壳/换 origin/新容器后的首启）且壳侧有
// 影子备份（setup 读 ~/.cc-deck/desktop-storage-shadow.json 注入 __CCDECK_SHADOW）时
// 同步恢复——initialization_script 先于页面任何脚本执行，页面初始化读到的即迁移后设置。
// 非空（同 origin 正常升级，WebKit 数据还在）一律不碰，永不覆盖现网设置
try {
  if (window.__CCDECK_SHADOW && localStorage.length === 0) {
    for (const k in window.__CCDECK_SHADOW) {
      try { localStorage.setItem(k, String(window.__CCDECK_SHADOW[k])); } catch (e) { /* 单键坏不挡其余 */ }
    }
  }
} catch (e) { /* localStorage 不可用（隐私模式等）静默 */ }
try { window.__TAURI__.core.invoke("web_diag", { msg: "init-script url=" + location.href + " rs=" + document.readyState }); } catch (e) { /* __TAURI__ 可能未就绪 */ }
if (!window.ccDeck) {
  window.ccDeck = {
    probeLocal: () => window.__TAURI__.core.invoke("probe_local"),
    openExternal: (url) => window.__TAURI__.core.invoke("open_external", { url }),
    openPath: (path, reveal) => window.__TAURI__.core.invoke("open_path", { path, reveal }),
    probePath: (path) => window.__TAURI__.core.invoke("probe_path", { path }),
    relayCtl: true, // 标记：内置 relay 开关能力存在（网页端据此显示设置行）
    relayStatus: () => window.__TAURI__.core.invoke("relay_status"),
    relayToggle: (on) => window.__TAURI__.core.invoke("relay_toggle", { on }),
    saveArtifact: (name, b64) => window.__TAURI__.core.invoke("save_artifact", { name, b64 }),
    // #240 IME 激活点击（仅 macOS 壳实现）：焦点真丢后拉回输入框必须走原生 hit-test
    imeClick: (x, y) => window.__TAURI__.core.invoke("ime_click", { x, y }),
  };
}
document.addEventListener("click", (e) => {
  if (e.defaultPrevented) return; // #101 双层去重：页面层兜底已处理过（两层时序在不同 WebView 上不定，先到先得）
  const a = e.target && e.target.closest ? e.target.closest('a[href^="http"]') : null;
  if (a && /^https?:/i.test(a.href)) {
    e.preventDefault();
    window.ccDeck.openExternal(a.href).catch(() => {});
  }
}, true);
window.open = (url) => {
  window.ccDeck.openExternal(String(url)).catch(() => {});
  return null;
};
// ── W-MIG localStorage 影子镜像（迁移备份的写侧）：全量 dump → 壳落
// ~/.cc-deck/desktop-storage-shadow.json（storage_shadow_write）。换壳/换 origin/
// 清库后，新壳首启由顶部种子块据此恢复。浏览器形态（无 __TAURI__）静默跳过零副作用；
// 幂等护栏防（理论上不发生的）脚本重复注入时监听器/定时器翻倍
if (!window.__CCDECK_MIRROR__) {
  window.__CCDECK_MIRROR__ = 1;
  let lastDump = null;
  const dumpLS = () => {
    try {
      const o = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        o[k] = localStorage.getItem(k);
      }
      return JSON.stringify(o);
    } catch (e) { return null; }
  };
  const flush = () => {
    if (!(window.__TAURI__ && window.__TAURI__.core)) return;
    const d = dumpLS();
    if (d === null || d === lastDump) return; // 无变化不写盘（15s 巡拍便宜的前提）
    lastDump = d;
    try { window.__TAURI__.core.invoke("storage_shadow_write", { payload: d }).catch(() => {}); } catch (e) { /* 壳桥异常静默 */ }
  };
  setTimeout(flush, 3000); // 首拍延迟：__TAURI__ 注入晚于本脚本时等它落地
  setInterval(flush, 15000); // 巡拍兜底（关窗到托盘的 hide 路径不触发 pagehide）
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
}
"##;

/// 本机 relay 探测（等价 Electron 的 cc-deck:probe-local）：
/// GET http://127.0.0.1:<relay_port>/local-info，1.5s 超时，返回 { ok, port, token } 或 null；
/// 失败静默（页面回退手动配置），不 panic 不弹错
#[tauri::command]
async fn probe_local() -> Option<Value> {
    // 端口跟随 relay_port（M2 变体默认 8788；生产 8787——行为不变）
    let endpoint = format!("http://127.0.0.1:{}/local-info", relay_port());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .ok()?;
    let resp = match client.get(&endpoint).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return None,
    };
    match resp.json::<Value>().await {
        Ok(j)
            if j.get("ok").and_then(Value::as_bool).unwrap_or(false)
                && j.get("token").is_some() =>
        {
            Some(j)
        }
        _ => None,
    }
}

/// 外链转系统浏览器（等价 Electron 的 setWindowOpenHandler + shell.openExternal）：
/// 只放行 http/https，其余协议静默忽略——壳内不导航到任意站点
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let lowered = url.to_ascii_lowercase();
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return Ok(());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// #29（C-P2-2）执行类/脚本类危险扩展：save_artifact 落盘下载目录与 open_path 系统
/// 默认程序打开两条 IPC 若被 XSS/假 relay 数据驱动（save 落 .bat 后 open 一次即
/// ShellExecute），构成 XSS→RCE 链。落盘与打开一律拒绝；reveal（文件管理器定位）
/// 只定位不执行，保持放行。.js/.sh 一并拒——Windows 下 WSH 双击即跑、macOS 下
/// .sh 双击开 Terminal 执行，交付物快速保存的便利不值得这条链（分享/下载入口不受影响）
const DANGEROUS_EXTS: &[&str] = &[
    "bat", "cmd", "com", "cpl", "scr", "pif", "msc", "hta", "lnk", "url", "reg", "scf",
    "inf", "ade", "adp", "mst", "jar", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1",
    "psm1", "ps2", "sh", "bash", "zsh", "command", "osx", "app", "exe", "dll", "msi",
    "apk", "deb", "rpm", "dmg", "pkg", "workflow",
];
fn dangerous_ext(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((_, e)) if !e.is_empty() => DANGEROUS_EXTS.contains(&e.to_ascii_lowercase().as_str()),
        _ => false,
    }
}

/// #326 打开转录里的本地文件：reveal=true 在文件管理器中定位该项，false 用系统默认
/// 程序打开。只接受绝对路径（盘符/UNC/斜杠开头）且拒含 ".."，防相对路径歧义与穿越；
/// opener 走系统 API 不经 shell，无注入面
#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String, reveal: bool) -> Result<(), String> {
    let p = path.trim();
    let b = p.as_bytes();
    let is_abs = (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || p.starts_with("\\\\")
        || p.starts_with('/');
    if !is_abs || p.contains("..") {
        return Err("仅支持绝对路径".into());
    }
    // #29（C-P2-2）：默认程序打开=Windows 上 ShellExecute，.bat/.lnk 等直接执行
    if !reveal && dangerous_ext(p) {
        return Err("已拒绝打开可执行/脚本类文件（防伪造产物执行），请用「在文件夹中显示」定位后自行处理".into());
    }
    if reveal {
        app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
    } else {
        app.opener().open_path(p, None::<&str>).map_err(|e| e.to_string())
    }
}

/// #106 返工（装机反馈「先报错路径没有文件，然后才下载」）：本地存在性探测——
/// 远程源产物路径在本机必然不存在，web 侧先探再决定直开还是下载，把分流做在
/// 后台（用户无感）。只读 stat，微秒级；绝对路径校验同 open_path
#[tauri::command]
fn probe_path(path: String) -> bool {
    let p = path.trim();
    let b = p.as_bytes();
    let is_abs = (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || p.starts_with("\\\\")
        || p.starts_with('/');
    is_abs && !p.contains("..") && std::path::Path::new(p).exists()
}

/// #106 输出物直接下载：web 侧拉取的字节流（base64）落系统「下载」目录，重名自动
/// -2/-3 递增不覆盖，返回落盘绝对路径。打开动作复用 open_path（前端随后调用，失败
/// toast 带路径，用户可手动找）。base64 解码内联实现——零新依赖（Cargo.lock 无 base64
/// 直依赖，不为这一处引 crate 让 CI 冷缓存多一个拉取点）
#[tauri::command]
fn save_artifact(app: tauri::AppHandle, name: String, b64: String) -> Result<String, String> {
    let bytes = b64_decode(&b64)?;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    // basename 语义：剥路径分隔符（前端已取 basename，这里兜底防目录穿越）
    let safe: String = name.chars().filter(|c| *c != '/' && *c != '\\' && *c != '\0').collect();
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("无效文件名".into());
    }
    // #29（C-P2-2）：可执行/脚本类扩展拒绝落盘下载目录（配合 open_path 守卫断
    // XSS→落盘→执行链；错误信息指引用分享/浏览器入口替代）
    if dangerous_ext(&safe) {
        return Err(format!("已拒绝保存可执行/脚本类文件（{safe}）：请用「分享」或浏览器打开后另存"));
    }
    // 重名递增：name.ext → name-2.ext（下载目录常有同名旧件，静默覆盖会吞用户文件）
    let (stem, ext) = match safe.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (safe.clone(), String::new()),
    };
    let mut path = dir.join(format!("{stem}{ext}"));
    let mut n = 1u32;
    while path.exists() {
        n += 1;
        if n > 999 {
            return Err("同名文件过多，请清理下载目录".into());
        }
        path = dir.join(format!("{stem}-{n}{ext}"));
    }
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// 标准字母表 base64 解码（web 侧 btoa 产物：padding 只在尾部，无空白）。
/// 过滤 '=' 后按 4 字符组还原；余 1 或出现非法字符即坏输入
fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, &c) in TBL.iter().enumerate() {
        rev[c as usize] = i as u8;
    }
    let body: Vec<u8> = s.bytes().filter(|b| !matches!(b, b'=' | b'\n' | b'\r')).collect();
    if body.len() % 4 == 1 || body.iter().any(|&b| rev[b as usize] == 255) {
        return Err("base64 解码失败".into());
    }
    let mut out = Vec::with_capacity(body.len() / 4 * 3);
    for g in body.chunks(4) {
        let v: Vec<u8> = g.iter().map(|&b| rev[b as usize]).collect();
        let n = ((v[0] as u32) << 18)
            | ((v[1] as u32) << 12)
            | ((*v.get(2).unwrap_or(&0) as u32) << 6)
            | (*v.get(3).unwrap_or(&0) as u32);
        out.push((n >> 16) as u8);
        if g.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if g.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::b64_decode;
    #[test]
    fn b64_roundtrip() {
        // 与 web 侧 btoa 同字母表：对照 Node crypto 生成的标准向量
        assert_eq!(b64_decode("").unwrap(), b"");
        assert_eq!(b64_decode("QQ==").unwrap(), b"A");
        assert_eq!(b64_decode("QUI=").unwrap(), b"AB");
        assert_eq!(b64_decode("QUJD").unwrap(), b"ABC");
        assert_eq!(b64_decode("SGVsbG8sIOS4lueVjA==").unwrap(), "Hello, 世界".as_bytes());
        assert!(b64_decode("A").is_err()); // 余 1
        assert!(b64_decode("Q*==").is_err()); // 非法字符
    }
}

/// 唤起主窗口：show + unminimize + focus（等价 Electron 的 showWin）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        // #19 呼出即打字：WebView2 键盘焦点不经点击直达页面——eval 补发 focus 事件，
        // 页面监听里把焦点放进消息输入框（真实 focus 事件偶发不派发时的兜底）
        let _ = w.eval("window.dispatchEvent(new Event('focus'))");
    }
}

/// #8/#66 呼出/收起切换：可见（且未最小化）→ 最小化；否则唤起。快捷键/托盘语义共用。
/// #66 起收起用 minimize 而非 hide——Windows 上 SW_HIDE 连任务栏图标一起藏
/// （用户实测收起后图标消失、失去唤回锚点），最小化保留任务栏图标可点击唤回
fn toggle_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false);
        if visible {
            let _ = w.minimize();
        } else {
            show_main(app);
        }
    }
}

/// #8 注册呼出/收起快捷键（换绑语义）：先注销旧键再注册新键；combo 空 = 注销。
/// 键位被其他应用占用时 register 报错上抛，网页侧 toast 提示
fn register_toggle_shortcut(app: &tauri::AppHandle, combo: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::ShortcutState;
    let gs = app.global_shortcut();
    let mut cur = TOGGLE_SHORTCUT.lock().unwrap();
    if let Some(old) = cur.take() {
        let _ = gs.unregister(old);
    }
    if combo.trim().is_empty() {
        return Ok(());
    }
    let shortcut: tauri_plugin_global_shortcut::Shortcut =
        combo.parse().map_err(|e| format!("快捷键格式无效：{e:?}"))?;
    gs.on_shortcut(shortcut, |app, _s, event| {
        if event.state == ShortcutState::Pressed {
            toggle_main(app);
        }
    })
    .map_err(|e| format!("快捷键注册失败（可能被其他应用占用）：{e}"))?;
    *cur = Some(shortcut);
    Ok(())
}

/// #8 网页侧改绑呼出/收起键：combo=null/空串注销。返回生效键位（空串=无快捷键）
#[tauri::command]
fn set_toggle_shortcut(app: tauri::AppHandle, combo: Option<String>) -> Result<String, String> {
    let c = combo.unwrap_or_default();
    register_toggle_shortcut(&app, &c)?;
    Ok(c)
}

/// #199 壳自身版本号（关于页显示口径）：桌面壳与 web-console 是两条独立版本线
///（壳=package.json 桌面线 test.N；控制台=CONSOLE_VERSION 随 APK 批次线）。旧口径
/// 只显控制台版本——壳更新后关于页版本号看似"倒退"（33→27）。壳内改显壳版本
///（tauri.conf 的 version 引用 package.json，构建期已解析进 config）；浏览器访问
/// 8787 时无此命令，回落控制台版本（那才是它的身份）
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.config().version.clone().unwrap_or_else(|| "unknown".into())
}

/// W-UIPOLISH ②诊断设施（保留无碍，页面不主动调用即零副作用）：壳内页面诊断通道——
/// 排查壳内渲染/加载问题时，在 INIT_SCRIPT 临时挂 invoke("web_diag") 即可把页面态
/// 转发到 stdout 与 /tmp 文件（stdout 重定向全缓冲会时序错乱，文件 append 实时）。
/// W-UIPOLISH ②真机循环凭此通道拿到壳内断言（radius/teamSource/timeRight 等）。
#[tauri::command]
fn web_diag(msg: String) {
    println!("[web-diag] {msg}");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true)
        .open("/tmp/wuipolish/web-diag.log")
    {
        use std::io::Write;
        let _ = writeln!(f, "{msg}");
    }
}

/// W-UIPOLISH ③诊断设施（同上保留）：程序化全屏切换——壳内三态验证用
#[tauri::command]
fn web_fullscreen(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

/// #240 IME 激活点击：web 传来 msginput 中心点的「WebView 本地坐标」（CSS px，左上原点），
/// 壳构造原生 NSEvent（mouseDown+mouseUp）经 NSApp sendEvent 派发——走 WebView 原生
/// hit-test 才会激活 NSTextInputClient（第三方输入法如微信输入法的组字上下文），
/// JS programmatic focus 不触发（实测：caret 闪、IME 悬浮条假活、打字全丢；系统
/// 输入法无恙，故仅第三方 IME 用户受害）。窗口本地坐标避开多屏 y 翻转；
/// W-UIFIX B（2026-10-11 test.11 真机反馈「界面显示不完整」根修配套）：窗口尺寸/位置记忆。
/// 物理像素存 app_config_dir/window-state.json（mac: ~/Library/Application Support/<identifier>/，
/// nova 与标准壳 identifier 不同天然分仓不互踩）。保存口=CloseRequested（hide 到托盘前，
/// mac 常态关窗每口保鲜）+ ExitRequested（托盘退出/app 级退出，窗口尚存）；Destroyed/Exit
/// 时窗口对象已失效拿不到尺寸，不设口。恢复口=setup 建窗后立即（同帧生效无闪烁），
/// 恢复前校验位置与任一显示器可视区相交——换屏/拔屏/文件脏数据时回 conf 默认，防窗口飞出看不见。
/// 状态结构手搓 JSON（Cargo.toml 只有 serde_json 直依赖，不引 serde derive）：
/// {"x":i32,"y":i32,"w":u32,"h":u32} 物理像素
fn window_state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window-state.json"))
}

fn save_window_state(app: &tauri::AppHandle) {
    let Some(path) = window_state_path(app) else { return };
    let Some(win) = app.get_webview_window("main") else { return };
    // W-UIPOLISH ③（test.14 用户实测「启动即全屏」根因）：全屏/最大化态不落盘——
    // 此两态 outer_size=整屏物理像素，存了下次启动就被 restore 成同尺寸普通窗＝假全屏。
    // 跳过保存保留最近一次普通态记忆；退出全屏后的下一次关窗/退出才刷新记忆
    if win.is_fullscreen().unwrap_or(false) || win.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
    if size.width == 0 || size.height == 0 { return; }
    let json = format!("{{\"x\":{},\"y\":{},\"w\":{},\"h\":{}}}", pos.x, pos.y, size.width, size.height);
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    let _ = std::fs::write(&path, json);
}

fn restore_window_state(win: &tauri::WebviewWindow) {
    let app = win.app_handle();
    let Some(path) = window_state_path(app) else { return };
    let Ok(txt) = std::fs::read_to_string(&path) else { return };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else { return };
    let (Some(x64), Some(y64), Some(w64), Some(h64)) = (
        v.get("x").and_then(Value::as_i64),
        v.get("y").and_then(Value::as_i64),
        v.get("w").and_then(Value::as_u64),
        v.get("h").and_then(Value::as_u64),
    ) else { return };
    // i64/u64 收敛回 tauri Pixel 类型（i32/u32）；越界脏数据回默认
    let (x, y) = (i32::try_from(x64).ok(), i32::try_from(y64).ok());
    let (Some(x), Some(y)) = (x, y) else { return };
    let (Ok(w), Ok(h)) = (u32::try_from(w64), u32::try_from(h64)) else { return };
    if w == 0 || h == 0 { return; }
    use tauri::PhysicalPosition;
    let visible = match app.available_monitors() {
        Ok(monitors) => monitors.iter().any(|m| {
            let (mp, ms) = (m.position(), m.size());
            let (mw, mh) = (ms.width as i32, ms.height as i32);
            // W-UIPOLISH ③ 脏数据迁移：test.14 前 save 不辨全屏态，已中招机器的
            // window-state.json 存着全屏尺寸（宽高恰好=某显示器整屏）。恢复前识别
            // 「盖满任一显示器」即丢弃回 conf 默认窗口态——用户手动拖大到整屏不会
            // 精确等值，误伤面趋零
            if x == mp.x && y == mp.y && w == ms.width && h == ms.height {
                return false;
            }
            x + w as i32 > mp.x && x < mp.x + mw && y + h as i32 > mp.y && y < mp.y + mh
        }),
        Err(_) => false,
    };
    if !visible { return; }
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

// ── W-MIG localStorage 影子备份（跨壳/跨 origin 设置迁移）──
// 背景：旧 Electron 壳（file:// 源，Chromium 存储）与 Tauri 壳（tauri.localhost /
// tauri://localhost 源，WKWebView 存储）localStorage 互不可见，用户换壳即设置全丢；
// nova 与标准壳 identifier 分仓同理。机制：页面侧 INIT_SCRIPT 全量 dump localStorage
// 经 storage_shadow_write 落盘（写侧）；setup 建窗时读备份注入 __CCDECK_SHADOW 种子块，
// 页面 localStorage 为空才恢复（读侧，见 INIT_SCRIPT 置顶）——种子文件 = 迁移起点，
// 不做双向同步，运行中的设置永不被打回。
fn storage_shadow_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    // 放 deck_root 而非 app_config_dir：后者按 identifier 分仓（分仓恰是要迁移的场景）；
    // deck_root 只随 M2_BUILD 变体隔离（M2 → ~/.cc-deck-m2，测试变体不串生产种子）
    Some(deck_root(&home).join("desktop-storage-shadow.json"))
}

/// 影子备份容量闸：设置镜像正常几 KB，超 1MB 视为脏数据拒收/拒恢复
const STORAGE_SHADOW_CAP: usize = 1024 * 1024;

/// 读影子备份（种子注入用）：缺失/超限/非 JSON 对象一律 None（不注入种子，行为=无迁移）
fn read_storage_shadow() -> Option<Value> {
    let txt = std::fs::read_to_string(storage_shadow_path()?).ok()?;
    if txt.len() > STORAGE_SHADOW_CAP {
        return None;
    }
    serde_json::from_str::<Value>(&txt).ok().filter(|v| v.is_object())
}

/// 写侧命令（INIT_SCRIPT 15s 巡拍 + pagehide/visibilitychange 兜底触发；JS 侧已做
/// 变更去重，无变化不触发）：只收 JSON 对象；tmp+rename 原子落盘——种子文件写一半
/// 坏掉 = 迁移链断，值得多两行
#[tauri::command]
fn storage_shadow_write(payload: String) -> Result<(), String> {
    let v: Value = serde_json::from_str(&payload).map_err(|_| "payload 非 JSON".to_string())?;
    if !v.is_object() {
        return Err("payload 须为 JSON 对象".into());
    }
    if payload.len() > STORAGE_SHADOW_CAP {
        return Err("payload 超 1MB 上限".into());
    }
    let path = storage_shadow_path().ok_or("无法定位用户目录")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, payload.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// app 内部 sendEvent 不经 HID，零辅助功能权限。仅 macOS；其他平台返回 Err
/// 由 web 侧回落 JS focus（Windows WebView2 无此病，#19 eval focus 已够）。
#[tauri::command]
fn ime_click(window: tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
        use objc2_foundation::NSPoint;
        if !window.is_focused().unwrap_or(false) {
            let _ = window.set_focus();
        }
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let h_pts = window.inner_size().map_err(|e| e.to_string())?.height as f64 / scale;
        // WebView CSS px（左上原点）→ NSEvent 窗口本地坐标（内容区左下原点）：仅 y 翻转
        let loc = NSPoint::new(x, h_pts - y);
        // #018-T2 适配 objc2-app-kit 0.3 生成绑定：sharedApplication 需 MainThreadMarker、
        // mouseEventWithType 生成为 snake_case 长名（参数序不变）。Tauri 同步 command 跑
        // 主线程，MainThreadMarker::new() 正常 Some；None=非常规调用态，显式报错不静默
        let mtm = MainThreadMarker::new().ok_or("ime_click 须在主线程调用")?;
        let app = NSApplication::sharedApplication(mtm);
        // 安全性：ns_window() 返回的 NSWindow 指针在本窗口存续期有效（Tauri 契约），
        // as_ref 仅在该前提下读 windowNumber
        let win_num = unsafe { (window.ns_window().map_err(|e| e.to_string())?
            as *mut NSWindow)
            .as_ref() }
            .map(|w| w.windowNumber())
            .unwrap_or(0);
        for ty in [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp] {
            let ev = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                ty, loc, NSEventModifierFlags::empty(), 0.0, win_num, None, 0, 1, 1.0,
            )
            .ok_or("NSEvent 构造失败")?;
            app.sendEvent(&ev);
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, x, y);
        Err("ime_click 仅 macOS".into())
    }
}

/// 托盘（等价 Electron 的 createTray）：默认窗口图标 + “显示主窗口/退出”菜单，双击唤起；
/// 任何一步失败整段回退（TRAY_OK=false），主窗口照常，关窗不再隐藏到托盘
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

    // 托盘图标分平台（2026-09-14 用户反馈菜单栏风格不一致 + 只显示品牌叠卡元素）：
    // macOS 用单色 template image（品牌重叠卡片剪影，系统自动适配深浅菜单栏）；
    // Windows/Linux 保持彩色窗口图标
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!(
        "../icons/tray-template.png"
    ))
    .map_err(|e| tauri::Error::AssetNotFound(format!("tray-template: {e}")))?;

    #[cfg(not(target_os = "macos"))]
    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default_window_icon".into()))?
        .clone();

    TrayIconBuilder::with_id("cc-deck-tray")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        // W15 双装：tooltip 随构建变体（CC Deck / CC Deck Nova）——同图标双托盘可分辨
        .tooltip(
            app.config()
                .product_name
                .clone()
                .unwrap_or_else(|| "CC Deck".into()),
        )
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => {
                QUITTING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ── #324 内嵌 relay / #334 启动自动启用 ──
// exe 只带 relay.mjs（1.9MB），node 用系统 PATH 的（装了 Claude Code 的机器必有）。
// 启动即检测：8787 已在服务 = 让位（插件 supervisor 或既有 relay）；无服务则静默
// 拉起内嵌 relay（用户无感，⚙ 设置行只作状态展示/手动停启）。
// CCR_DESKTOP_RELAY_PORT：测试通道（本机 8787 被生产 relay 占时换端口验证启动分支）。
static EMBEDDED_RELAY: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);
// #17 内嵌 relay 启动/引导失败原因（node 过旧 SyntaxError / spawn 失败 / 起后即退）——
// relay_status 透出给网页状态行展示，替代死板的「未检测到」
static EMBEDDED_RELAY_ERR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
// #66 relay 存续意愿：本方成功 spawn 置 true；用户手动停（relay_toggle off）与
// 应用退出（kill_embedded_relay）置 false。监督线程据此区分「该重拉」与「别添乱」
static RELAY_WANTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// #36 M2 并行测试变体（2026-10-03 用户拍板）：构建期 CCDECK_BUILD_M2=1 烙入——与
// 生产 CC Deck 同机并存互不干扰（默认端口 8788、数据/组织根 ~/.cc-deck-m2、断
// 生产 bridge.json 镜像、mDNS 广播名带 M2）。生产构建不设该 env = 行为与从前
// 逐字节一致，提交面保持生产缺省（M2 只在构建命令行注入）
const M2_BUILD: bool = option_env!("CCDECK_BUILD_M2").is_some();

const PRODUCTION_RELAY_PORT: u16 = 8787;
const M2_RELAY_PORT: u16 = 8788;

fn default_relay_port(m2: bool) -> u16 {
    if m2 { M2_RELAY_PORT } else { PRODUCTION_RELAY_PORT }
}

fn relay_port() -> u16 {
    std::env::var("CCR_DESKTOP_RELAY_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default_relay_port(M2_BUILD))
}

// cc-deck 根目录：生产 ~/.cc-deck，M2 变体 ~/.cc-deck-m2（数据/内嵌日志全量隔离）
fn deck_root(home: &str) -> std::path::PathBuf {
    std::path::Path::new(home).join(if M2_BUILD { ".cc-deck-m2" } else { ".cc-deck" })
}

fn port_listening(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResourceState {
    Present,
    Missing,
    InvalidPath,
}

#[derive(Debug, Clone)]
struct EmbeddedRelayResources {
    script: std::path::PathBuf,
    inject_cs: std::path::PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResourceProbe {
    script: ResourceState,
    inject_cs: ResourceState,
}

fn absolute_resource_path(path: std::path::PathBuf) -> std::path::PathBuf {
    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    let mut value = canonical.to_string_lossy().into_owned();
    if let Some(stripped) = value.strip_prefix("\\\\?\\") {
        value = stripped.to_string();
    }
    std::path::PathBuf::from(value)
}

fn embedded_relay_resources(resource_dir: &std::path::Path) -> EmbeddedRelayResources {
    EmbeddedRelayResources {
        script: absolute_resource_path(resource_dir.join("resources").join("relay.mjs")),
        inject_cs: absolute_resource_path(resource_dir.join("resources").join("bin").join("inject.cs")),
    }
}

fn probe_resource_path(path: &std::path::Path) -> ResourceState {
    if !path.is_absolute() {
        return ResourceState::InvalidPath;
    }
    if !path.exists() {
        return ResourceState::Missing;
    }
    if path.is_file() {
        ResourceState::Present
    } else {
        ResourceState::InvalidPath
    }
}

fn probe_embedded_relay_resources(resource_dir: &std::path::Path) -> ResourceProbe {
    let resources = embedded_relay_resources(resource_dir);
    ResourceProbe {
        script: probe_resource_path(&resources.script),
        inject_cs: probe_resource_path(&resources.inject_cs),
    }
}

fn resource_error(label: &str, path: &std::path::Path, state: ResourceState) -> String {
    match state {
        ResourceState::Missing => format!("内置 {label} 缺失：{}", path.display()),
        ResourceState::InvalidPath => format!("内置 {label} 路径无效：{}", path.display()),
        ResourceState::Present => String::new(),
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelayPortOwner {
    Available,
    EmbeddedRelay,
    ExternalRelay,
    ExternalProcess,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayPortProbe {
    port: u16,
    owner: RelayPortOwner,
    process_name: Option<String>,
}

#[allow(dead_code)]
impl RelayPortProbe {
    fn conclusion(&self) -> String {
        match self.owner {
            RelayPortOwner::Available => format!("端口 {} 空闲", self.port),
            RelayPortOwner::EmbeddedRelay => format!("端口 {} 由自家 relay 占用", self.port),
            RelayPortOwner::ExternalRelay => format!("端口 {} 由外部 relay 占用", self.port),
            RelayPortOwner::ExternalProcess => format!(
                "端口 {} 由外来进程占用（{}）",
                self.port,
                self.process_name.as_deref().unwrap_or("进程名未知"),
            ),
        }
    }
}

fn classify_relay_port(listening: bool, embedded: bool, relay_handshake: bool) -> RelayPortOwner {
    if !listening {
        RelayPortOwner::Available
    } else if embedded {
        RelayPortOwner::EmbeddedRelay
    } else if relay_handshake {
        RelayPortOwner::ExternalRelay
    } else {
        RelayPortOwner::ExternalProcess
    }
}

#[allow(dead_code)]
fn relay_handshake(port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
    if stream
        .write_all(b"GET /local-info HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = Vec::new();
    if stream.read_to_end(&mut response).is_err() {
        return false;
    }
    let response_text = String::from_utf8_lossy(&response);
    let body = response_text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or("");
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("ok").and_then(Value::as_bool))
        .unwrap_or(false)
}

#[cfg(unix)]
#[allow(dead_code)]
fn process_name_for_port(port: u16) -> Option<String> {
    let output = std::process::Command::new("lsof")
        .args(["-nP", "-a", "-iTCP", &port.to_string(), "-sTCP:LISTEN", "-Fpc"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('c').filter(|name| !name.is_empty()).map(str::to_owned))
}

#[cfg(not(unix))]
#[allow(dead_code)]
fn process_name_for_port(_port: u16) -> Option<String> {
    None
}

#[allow(dead_code)]
fn probe_relay_port(port: u16) -> RelayPortProbe {
    let listening = port_listening(port);
    let embedded = EMBEDDED_RELAY.lock().map(|relay| relay.is_some()).unwrap_or(false);
    let handshake = listening && !embedded && relay_handshake(port);
    let process_name = if listening && !embedded && !handshake {
        process_name_for_port(port)
    } else {
        None
    };
    RelayPortProbe {
        port,
        owner: classify_relay_port(listening, embedded, handshake),
        process_name,
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayDevContract {
    name: &'static str,
    default_port: u16,
    port_env: &'static str,
    data_dir_env: &'static str,
}

#[allow(dead_code)]
fn relay_dev_contracts() -> [RelayDevContract; 2] {
    [
        RelayDevContract { name: "production", default_port: PRODUCTION_RELAY_PORT, port_env: "CCR_PORT", data_dir_env: "CCR_DATA_DIR" },
        RelayDevContract { name: "M2", default_port: M2_RELAY_PORT, port_env: "CCR_PORT", data_dir_env: "CCR_DATA_DIR" },
    ]
}

fn relay_spawn_env(port: u16, data_dir: &std::path::Path, inject_cs: &std::path::Path, parent_pid: u32) -> Vec<(String, String)> {
    vec![
        ("CCR_PORT".into(), port.to_string()),
        ("CCR_DATA_DIR".into(), data_dir.to_string_lossy().into_owned()),
        ("CCR_INJECT_CS".into(), inject_cs.to_string_lossy().into_owned()),
        ("CCR_NOHOOK_IDLE_MS".into(), "60000".into()),
        ("CCR_PARENT_PID".into(), parent_pid.to_string()),
    ]
}

fn apply_relay_spawn_env(cmd: &mut std::process::Command, envs: &[(String, String)]) {
    cmd.env_remove("NODE_OPTIONS");
    for (key, value) in envs {
        cmd.env(key, value);
    }
}

// node 探测只做 PATH 查找（不执行 node——Windows 商店的 WindowsApps 假别名 stub
// 会让 `node --version` 挂起不返回）。按平台分流：
// - Windows：where.exe；#13 路径含 WindowsApps（商店 stub）一律视为未装
// - macOS（#72）：GUI app 的 PATH 不含用户 shell 的自定义路径（~/node/bin 等），
//   which 大概率落空——枚举常见安装位置 + which 双通道
#[cfg(target_os = "windows")]
fn node_path() -> Option<std::path::PathBuf> {
    // #206（W-NODE）：where 失败/无命中继续探用户级安装位（此前 where 一败即 None）
    if let Ok(out) = std::process::Command::new("where").arg("node").output() {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let first = line.trim();
                if first.is_empty() || first.to_ascii_lowercase().contains("windowsapps") { continue; }
                return Some(std::path::PathBuf::from(first));
            }
        }
    }
    // 用户级安装位：nvm-windows（%APPDATA%\nvm\nodejs 常不在 GUI PATH）+ volta + fnm
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let mut candidates: Vec<String> = vec![
        format!("{appdata}\\nvm\\nodejs\\node.exe"),
        format!("{localappdata}\\Volta\\bin\\node.exe"),
        format!("{localappdata}\\fnm\\node.exe"),
    ];
    if let Ok(nvm_home) = std::env::var("NVM_HOME") {
        candidates.push(format!("{nvm_home}\\node.exe"));
    }
    for c in candidates {
        let p = std::path::PathBuf::from(&c);
        if p.is_file() { return Some(std::path::PathBuf::from(c)); }
    }
    None
}
#[cfg(not(target_os = "windows"))]
fn node_path() -> Option<std::path::PathBuf> {
    // ① which（系统安装位通常在 GUI PATH 内：/usr/local/bin、/opt/homebrew/bin）
    if let Ok(out) = std::process::Command::new("which").arg("node").output() {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let first = line.trim();
                if !first.is_empty() { return Some(std::path::PathBuf::from(first)); }
            }
        }
    }
    // ② GUI PATH 摸不到的用户安装位（zshrc 自定义 PATH 的常见形态）。
    // #206（W-NODE）：nvm 逐版本目录扫最新（"current" 链接多数发行不建）+ volta +
    // ~/.local/bin 三族补齐——公司机装了 node 但 GUI 探不到的实锤面
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<String> = vec![
        format!("{home}/node/bin/node"),
        format!("{home}/.volta/bin/node"),
        format!("{home}/.local/bin/node"),
        "/usr/local/bin/node".to_string(),
        "/opt/homebrew/bin/node".to_string(),
        "/opt/local/bin/node".to_string(),
    ];
    let nvm_dir = format!("{home}/.nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
        let mut vers: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        vers.sort();
        if let Some(latest) = vers.last() {
            candidates.insert(0, format!("{nvm_dir}/{latest}/bin/node"));
        }
    }
    for c in candidates {
        let p = std::path::PathBuf::from(&c);
        if p.exists() { return Some(std::path::PathBuf::from(c)); }
    }
    None
}

fn node_in_path() -> bool {
    node_path().is_some()
}

// ── #206（W-NODE 定稿）：可选 Node + 应用内一键安装 ──
// 找包序：app-data/node（应用内安装位，deck_root/app-data/node/）→ 系统 PATH（含
// nvm/volta/用户级增强探测）。默认包不带 Node（体积不变）；无 Node 时前端弹一键
// 安装框（node_install command：系统 curl 下载官方包+sha256 校验+系统 tar/
// Expand-Archive 解压——零新增 Cargo 依赖）；装完无需重启（下次 spawn 即用新路径）
const NODE_DIST_VER: &str = "v22.14.0"; // LTS；与开发机 node 22 同大版本

#[cfg(target_os = "windows")]
fn node_dist_bin(home: &std::path::Path) -> std::path::PathBuf {
    deck_root(&home.to_string_lossy()).join("app-data").join("node").join("node.exe")
}
#[cfg(not(target_os = "windows"))]
fn node_dist_bin(home: &std::path::Path) -> std::path::PathBuf {
    deck_root(&home.to_string_lossy()).join("app-data").join("node").join("bin").join("node")
}

/// 一键安装后的内置运行时路径（在场才 Some）
fn appdata_node_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    let p = node_dist_bin(std::path::Path::new(&home));
    if p.is_file() { Some(p) } else { None }
}

/// relay 启动找包序（#206 ③）：app-data/node → 系统（nvm/volta/用户级）→ None
fn relay_node_path() -> Option<std::path::PathBuf> {
    appdata_node_path().or_else(node_path)
}

// node 探测结果进程内缓存：where.exe 首跑可能被 Defender 实时扫描拖 1-2s，
// 每次状态查询都 spawn 会把设置面板开合卡出可感知延迟（#342 卡顿主因之一）
static NODE_OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn relay_status_value() -> Value {
    let node = *NODE_OK.get_or_init(node_in_path);
    let err = EMBEDDED_RELAY_ERR.lock().unwrap().clone();
    serde_json::json!({
        "port": port_listening(relay_port()),
        "embedded": EMBEDDED_RELAY.lock().unwrap().is_some(),
        "node": node,
        "err": err,
    })
}

#[tauri::command]
async fn relay_status() -> Value {
    relay_status_value()
}

fn spawn_embedded_relay(app: &tauri::AppHandle) -> Result<(), String> {
    if EMBEDDED_RELAY.lock().unwrap().is_some() {
        return Ok(());
    }
    let port = relay_port();
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    // resource_dir 可能给盘符相对路径（"D:..."），CreateProcess 传参会被 node 解析成
    // 纯盘符 EISDIR——canonicalize 成 \?\ 绝对路径，一劳永逸
    // canonicalize 后剥掉 \?\ verbatim 前缀：node 的 realpathSync 不认它（剥成盘符 EISDIR）
    let resources = embedded_relay_resources(&res);
    let resource_probe = probe_embedded_relay_resources(&res);
    let script = resources.script;
    let inject_cs = resources.inject_cs;
    println!("[embedded-relay] script={}", script.display());
    if resource_probe.script != ResourceState::Present {
        return Err(resource_error("relay.mjs", &script, resource_probe.script));
    }
    if resource_probe.inject_cs != ResourceState::Present {
        return Err(resource_error("inject.cs", &inject_cs, resource_probe.inject_cs));
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|_| "无法定位用户目录".to_string())?;
    let data_dir = deck_root(&home).join("data");
    let _ = std::fs::create_dir_all(&data_dir);
    // M2 变体增补 env（#36 并行测试版）：组织数据隔离到 ~/.cc-deck-m2/org；org CLI
    // 显式落共享位 ~/.cc-deck/bin/org（ORG_LEADER_BOOTSTRAP_PROMPT 硬编码该绝对
    // 路径，且 ensureOrgCli 在「设 ORG_DIR 而未设 ORG_BIN_DIR」时不物化）；断
    // bridge.json 镜像（不覆写生产归属文件）；mDNS 广播名后缀（发现列表可分辨）。
    // 生产构建为空集零增补
    let extra_env: Vec<(String, String)> = if M2_BUILD {
        vec![
            ("CCR_ORG_DIR".to_string(), deck_root(&home).join("org").to_string_lossy().into_owned()),
            ("CCR_ORG_BIN_DIR".to_string(), std::path::Path::new(&home).join(".cc-deck").join("bin").join("org").to_string_lossy().into_owned()),
            ("CCR_NO_BRIDGE_MIRROR".to_string(), "1".to_string()),
            ("CCR_MDNS_NAME".to_string(), "CC Deck M2 Relay".to_string()),
        ]
    } else {
        Vec::new()
    };
    // #71 跨平台：CREATE_NO_WINDOW 是 Windows 专属（防 node 子进程闪 cmd 窗），
    // mac 上无此概念——cfg 门控按平台分流
    #[cfg(target_os = "windows")]
    fn spawn_relay(node: &std::path::Path, script: &std::path::Path, port: u16, data_dir: &std::path::Path, inject_cs: &std::path::Path, log: &std::path::Path, extra_env: &[(String, String)]) -> std::io::Result<std::process::Child> {
        use std::os::windows::process::CommandExt;
        let out = std::fs::File::create(log)?;
        let mut cmd = std::process::Command::new(node);
        let envs = relay_spawn_env(port, data_dir, inject_cs, std::process::id());
        cmd.arg(script);
        apply_relay_spawn_env(&mut cmd, &envs);
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        cmd.stdout(out.try_clone()?)
            .stderr(out)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
    }
    #[cfg(not(target_os = "windows"))]
    fn spawn_relay(node: &std::path::Path, script: &std::path::Path, port: u16, data_dir: &std::path::Path, inject_cs: &std::path::Path, log: &std::path::Path, extra_env: &[(String, String)]) -> std::io::Result<std::process::Child> {
        let out = std::fs::File::create(log)?;
        let mut cmd = std::process::Command::new(node);
        let envs = relay_spawn_env(port, data_dir, inject_cs, std::process::id());
        cmd.arg(script);
        apply_relay_spawn_env(&mut cmd, &envs);
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        cmd.stdout(out.try_clone()?)
            .stderr(out)
            .spawn()
    }
    let log = data_dir.join("embedded-relay.log");
    // #206：找包序 app-data → 系统；都无=可安装态（前端一键装框），err 文案带
    // 双指引（一键装/手动 nodejs.org LTS）
    let node = relay_node_path().ok_or(
        "缺少 Node.js 运行时——点「一键安装」自动下载（约 30MB，装到 CC Deck 自己的数据目录，不动系统）；或浏览器打开 nodejs.org 下载 LTS 安装后重启",
    )?;
    match spawn_relay(&node, &script, port, &data_dir, &inject_cs, &log, &extra_env)
    {
        Ok(child) => {
            println!("[embedded-relay] spawned pid={} port={}", child.id(), port);
            *EMBEDDED_RELAY.lock().unwrap() = Some(child);
            Ok(())
        }
        Err(e) => Err(format!("relay 启动失败（node 不在 PATH？）：{e}")),
    }
}

// ── #206 ②：应用内一键安装 Node（curl 下载+sha256 校验+tar/Expand-Archive 解压，
// 全系统工具零 Cargo 新依赖）。线程跑+事件 emit 进度（前端进度条）；装完直接
// spawn_embedded_relay（无需重启 App——启动器每次现找 app-data 优先）。
// 互斥锁防双击重入；失败 err 事件带原因（前端可重试）。
static NODE_INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn node_dist_download(home: &str) -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "windows")]
    let (fname, kind) = (format!("node-{}-win-x64.zip", NODE_DIST_VER), "zip");
    #[cfg(not(target_os = "windows"))]
    let (fname, kind) = (format!("node-{}-darwin-arm64.tar.gz", NODE_DIST_VER), "tar.gz");
    let url = format!("https://nodejs.org/dist/{}/{}", NODE_DIST_VER, fname);
    let tmp = std::env::temp_dir().join(format!("ccdeck-node-install-{fname}"));
    println!("[node-install] {url}");
    // -L 跟重定向；--retry 3 网络抖动；静默+失败码透传（curl stderr 进 String）
    let out = std::process::Command::new("curl")
        .args(["-fsSL", "--retry", "3", "-o"])
        .arg(&tmp)
        .arg(&url)
        .output()
        .map_err(|e| format!("curl 启动失败（系统缺 curl？）：{e}"))?;
    if !out.status.success() {
        return Err(format!("下载失败（HTTP {}）：{}", out.status.code().unwrap_or(0), String::from_utf8_lossy(&out.stderr).trim()));
    }
    let size = tmp.metadata().map(|m| m.len()).unwrap_or(0);
    if size < 5_000_000 { return Err(format!("下载产物异常（{}B <5MB——截断或坏包）", size)); }
    // sha256 校验（系统工具：mac shasum / win certutil）
    #[cfg(target_os = "windows")]
    let sum_out = std::process::Command::new("certutil").args(["-hashfile", tmp.to_str().unwrap_or(""), "SHA256"]).output().map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "windows"))]
    let sum_out = std::process::Command::new("shasum").args(["-a", "256", tmp.to_str().unwrap_or("")]).output().map_err(|e| e.to_string())?;
    if !sum_out.status.success() { return Err("sha256 计算失败".into()); }
    let sum_text = String::from_utf8_lossy(&sum_out.stdout).to_lowercase();
    let got = sum_text.split_whitespace().find(|t| t.len() == 64).unwrap_or("").to_string();
    // 官方 SHASUMS256.txt 拉取比对（小文件直接拉）
    let shasum_url = format!("https://nodejs.org/dist/{}/SHASUMS256.txt", NODE_DIST_VER);
    let shas = std::process::Command::new("curl").args(["-fsSL", &shasum_url]).output().map_err(|e| e.to_string())?;
    if !shas.status.success() { return Err("SHASUMS256.txt 拉取失败".into()); }
    let want = String::from_utf8_lossy(&shas.stdout)
        .lines()
        .find(|l| l.ends_with(&fname))
        .and_then(|l| l.split_whitespace().next())
        .unwrap_or("").to_lowercase();
    if want.is_empty() || got != want {
        return Err(format!("sha256 不符（want={}… got={}…）——坏包或被劫持，已中止", &want[..8.min(want.len())], &got[..8.min(got.len())]));
    }
    println!("[node-install] sha256 OK");
    // 解压到 app-data/node/（deck_root/app-data/node/{bin/node|node.exe}）
    let root = deck_root(home);
    let dest = root.join("app-data").join("node");
    let stage = std::env::temp_dir().join("ccdeck-node-stage");
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    if kind == "tar.gz" {
        let out = std::process::Command::new("tar").args(["-xzf"]).arg(&tmp).arg("-C").arg(&stage).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(format!("tar 解压失败：{}", String::from_utf8_lossy(&out.stderr).trim())); }
        // node-vX-darwin-arm64/bin/node → dest/bin/node（只取 node 本体，npm/corepack 不带）
        let src_bin = stage.join(format!("node-{}-darwin-arm64", NODE_DIST_VER)).join("bin").join("node");
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(dest.join("bin")).map_err(|e| e.to_string())?;
        std::fs::copy(&src_bin, dest.join("bin").join("node")).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dest.join("bin").join("node"), std::fs::Permissions::from_mode(0o755));
        }
    } else {
        let out = std::process::Command::new("powershell").args(["-NoProfile", "-Command",
            &format!("Expand-Archive -Force -Path '{}' -DestinationPath '{}'", tmp.to_string_lossy(), stage.to_string_lossy())])
            .output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(format!("Expand-Archive 失败：{}", String::from_utf8_lossy(&out.stderr).trim())); }
        let src_bin = stage.join(format!("node-{}-win-x64", NODE_DIST_VER)).join("node.exe");
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        std::fs::copy(&src_bin, dest.join("node.exe")).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&stage);
    let _ = std::fs::remove_file(&tmp);
    // 终验：解出来的 node 能跑 --version（哑包/架构错在此拦截）
    let bin = node_dist_bin(std::path::Path::new(home));
    let ver = std::process::Command::new(&bin).arg("--version").output().map_err(|e| format!("解压后 node 不可执行：{e}"))?;
    if !ver.status.success() { return Err("内置 node --version 失败（架构不符？）".into()); }
    println!("[node-install] {} → {}", String::from_utf8_lossy(&ver.stdout).trim(), bin.display());
    Ok(bin)
}

#[tauri::command]
async fn node_install(app: tauri::AppHandle) -> Result<Value, String> {
    if NODE_INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("安装已在进行中".into());
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|_| "无法定位用户目录".to_string())?;
    let app2 = app.clone();
    // 后台线程：curl 同步下载（数十 MB 秒级~分钟级），不堵 IPC
    std::thread::spawn(move || {
        let emit = |stage: &str, detail: String| {
            let _ = app2.emit("node-install-progress", serde_json::json!({ "stage": stage, "detail": detail }));
        };
        emit("downloading", "下载 Node 官方包（约 30MB）…".into());
        let result = node_dist_download(&home)
            .and_then(|bin| {
                emit("spawning", format!("已装到 {}——拉起内置 relay…", bin.display()));
                // 无需重启：直接走既有 spawn（找包序 app-data 优先自动命中）
                let handle = app2.app_handle();
                if let Err(e) = spawn_embedded_relay(&handle) {
                    // relay 已被别方占用等非致命态：安装本身成功，relay 状态照常查询
                    emit("done", format!("Node 已就绪（relay：{e}）"));
                } else {
                    emit("done", "Node 已就绪，内置 relay 已启动".into());
                }
                Ok(())
            });
        if let Err(e) = result {
            emit("error", e);
        }
        NODE_INSTALLING.store(false, Ordering::SeqCst);
    });
    Ok(serde_json::json!({ "started": true }))
}

#[tauri::command]
fn relay_toggle(app: tauri::AppHandle, on: bool) -> Result<Value, String> {
    if !on {
        // #66 用户手动停：先撤 WANT 再杀，监督线程不会把它拉回来
        RELAY_WANTED.store(false, Ordering::SeqCst);
        if let Some(mut c) = EMBEDDED_RELAY.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
            println!("[embedded-relay] stopped by user");
        } else if port_listening(relay_port()) {
            // #76 端口上有 relay 但非本应用子进程（launchd 服务/插件 supervisor 托管）——
            // 本开关管不到也不该 kill，透出指引，否则用户点「关」看似无效
            *EMBEDDED_RELAY_ERR.lock().unwrap() = Some(
                "端口上的 relay 由外部托管（系统服务/插件）——此开关只管理应用内嵌实例。停用系统服务：终端跑 deploy/mac-relay-launchd/disable.sh".into(),
            );
            println!("[embedded-relay] toggle-off skipped: externally managed relay on port {}", relay_port());
        }
        return Ok(relay_status_value());
    }
    if port_listening(relay_port()) {
        println!("[embedded-relay] port {} already serving - nothing to do", relay_port());
        RELAY_WANTED.store(true, Ordering::SeqCst);
        return Ok(relay_status_value()); // 已有 relay（插件/手动），视为"开启"状态
    }
    spawn_embedded_relay(&app)?;
    RELAY_WANTED.store(true, Ordering::SeqCst);
    Ok(relay_status_value())
}

/// #334 自动启用后的就绪等待：端口可连即返回；子进程中途死掉（端口起不来）也
/// 立即返回不空等。全程静默，最多拖慢开窗 wait_ms
fn wait_port_ready(port: u16, wait_ms: u64) {
    let t0 = std::time::Instant::now();
    loop {
        if port_listening(port) {
            // 就绪收割：端口可连但若我方子进程已死（bind 竞态败给插件守护 relay/闪退），
            // 摘掉句柄防 relay_status 的 embedded 虚报 true（审查#4）
            let mut g = EMBEDDED_RELAY.lock().unwrap();
            if let Some(c) = g.as_mut() {
                if matches!(c.try_wait(), Ok(Some(_))) {
                    *g = None;
                    println!("[embedded-relay] child exited (lost bind race?) - detached");
                }
            }
            drop(g);
            println!("[embedded-relay] ready after {}ms", t0.elapsed().as_millis());
            return;
        }
        let mut g = EMBEDDED_RELAY.lock().unwrap();
        if let Some(c) = g.as_mut() {
            if matches!(c.try_wait(), Ok(Some(_))) {
                // 子进程已退出：摘掉句柄让 relay_status 回到未运行态，别等满超时
                *g = None;
                println!("[embedded-relay] child exited during startup wait");
                return;
            }
        }
        drop(g);
        if t0.elapsed().as_millis() as u64 >= wait_ms {
            println!("[embedded-relay] port not ready in {}ms, continue anyway", wait_ms);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
}

// #66 relay 子进程监督：此前只在启动时 spawn 一次，进程中途退出（部署热换 kill/崩溃/
// OOM）后无人接管——桌面端「本机 relay 未检测到」、手机全断，只能用户手动重启桌面端
// （2026-09-19 用户反馈「每次部署成功都需要我手动重启服务端软件，这是不对的」）。
// 监督线程 1.5s 一拍：收割已退出的子进程句柄 → 端口无服务且 WANT=true → 重拉。
// 安全边界（不打架的三条路径全走 take() 句柄）：用户设置里手动停 = WANT 置 false；
// 应用退出 = kill_embedded_relay 内置 WANT false + QUITTING；端口被外部 relay
// （插件 supervisor）占着 = 只让位不抢。连续暴毙按 2s→4s→…→32s 指数退避，防
// node 过旧时打转；稳定运行 60s 后计数清零。
fn supervise_embedded_relay(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last_spawn = std::time::Instant::now();
        let mut strikes = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            if !RELAY_WANTED.load(Ordering::SeqCst) || QUITTING.load(Ordering::SeqCst) {
                strikes = 0;
                continue;
            }
            let need_spawn = {
                let mut g = EMBEDDED_RELAY.lock().unwrap();
                // 意外死亡的形态：句柄仍在、进程已退。收割掉再决定是否重拉
                let mut reaped = false;
                if let Some(c) = g.as_mut() {
                    if matches!(c.try_wait(), Ok(Some(_))) {
                        reaped = true;
                    }
                }
                if reaped {
                    *g = None;
                    println!("[embedded-relay] #66 child exited unexpectedly - will respawn");
                }
                // 本方子进程活着（含 node 冷启动窗口）不打扰；无本方进程且端口
                // 无服务才需要拉——外部 relay 在服务时让位
                if g.is_some() { false } else { !port_listening(relay_port()) }
            };
            if !need_spawn {
                strikes = 0;
                continue;
            }
            // 稳定跑过 60s 重新计数；strike 1 立即重拉，其后 2/4/8/16/32s 退避
            if last_spawn.elapsed().as_secs() > 60 {
                strikes = 0;
            }
            if strikes > 0 {
                let wait_ms = 1000u64.saturating_mul(1u64 << strikes.min(5));
                println!("[embedded-relay] #66 respawn backoff {wait_ms}ms (strike {strikes})");
                std::thread::sleep(std::time::Duration::from_millis(wait_ms));
                // 退避窗口内用户关掉了/应用要退：放弃本次
                if !RELAY_WANTED.load(Ordering::SeqCst) || QUITTING.load(Ordering::SeqCst) {
                    continue;
                }
            }
            match spawn_embedded_relay(&app) {
                Ok(()) => {
                    last_spawn = std::time::Instant::now();
                    println!("[embedded-relay] #66 respawned");
                }
                Err(e) => println!("[embedded-relay] #66 respawn failed: {e}"),
            }
            strikes += 1;
        }
    });
}

fn kill_embedded_relay() {
    RELAY_WANTED.store(false, Ordering::SeqCst);
    if let Some(mut c) = EMBEDDED_RELAY.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
        println!("[embedded-relay] stopped on app exit");
    }
}

// ── #76/#196 relay 系统服务化（macOS launchd）：设置页「开机自启」开关背后 ──
// 服务化 = relay 注册为 LaunchAgent（RunAtLoad + KeepAlive + 5s 节流重拉）。壳让位
// 逻辑零新增：supervisor 的 need_spawn=「无本方子进程 && 端口无服务」，端口被服务
// 占住即自然让位；服务停用后端口空出，supervisor 1.5s 内重拉内嵌实例（无缝回退）。
// 与 deploy/mac-relay-launchd/ 脚本同款 plist 模板（终端用户没有仓库，逻辑内嵌壳里）。
// Windows 版走任务计划器，后续另做——开关 cfg 门控只在 macOS 露出。
// 服务 label 随 M2_BUILD 变体化（G1，W-SVCDESIGN 2026-10-10）：固定常量下 M2 构建
// 开「开机自启」会注册生产变体的 label——同机双变体互覆写 plist、bootout 互删、
// 8787/8788 两服务绑同一 label 互相顶掉。命名与现场手工 M2 服务一致（该命名已被
// 现场权威化）。生产构建返回值与旧常量逐字相同，行为零变化。
fn relay_service_label() -> &'static str {
    if M2_BUILD {
        "online.humumu.ccdeck.m2.relay"
    } else {
        "online.humumu.ccdeck.relay"
    }
}

#[cfg(target_os = "macos")]
fn current_uid() -> u32 {
    static UID: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *UID.get_or_init(|| {
        std::process::Command::new("id").arg("-u").output().ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
            .unwrap_or(501)
    })
}

#[cfg(target_os = "macos")]
fn launchctl(args: &[&str]) -> std::io::Result<std::process::Output> {
    std::process::Command::new("launchctl").args(args).output()
}

/// 服务是否已注册进 launchd（print 命中即注册；plist 在但未 bootstrap 不算）
#[cfg(target_os = "macos")]
fn relay_service_registered() -> bool {
    let target = format!("gui/{}/{}", current_uid(), relay_service_label());
    matches!(launchctl(&["print", &target]), Ok(o) if o.status.success())
}

/// 生成 launchd plist（node/脚本/数据目录全用本机解析出的绝对路径——launchd 环境
/// 极简，不留运行时猜测）。与 enable.sh 同模板：不传 CCR_PARENT_PID（服务化模式，
/// relay parentPid=0 自动跳过父进程轮询）
#[cfg(target_os = "macos")]
fn write_relay_service_plist(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let node = relay_node_path().ok_or("缺少 Node.js 运行时（一键安装或 nodejs.org LTS）——relay 服务化需要它")?;
    let node = node.to_string_lossy().into_owned();
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    let abs = |p: std::path::PathBuf| {
        let c = std::fs::canonicalize(&p).unwrap_or(p);
        c.to_string_lossy().into_owned()
    };
    let script = abs(res.join("resources").join("relay.mjs"));
    if !std::path::Path::new(&script).exists() {
        return Err("内置 relay.mjs 缺失（安装包损坏？重装试试）".into());
    }
    let inject_cs = abs(res.join("resources").join("bin").join("inject.cs"));
    let home = std::env::var("HOME").map_err(|_| "无法定位用户目录".to_string())?;
    // #018-T2：走 deck_root（M2 变体 → ~/.cc-deck-m2/data）——此前硬编码 ~/.cc-deck/data，
    // M2 构建开「开机自启」会把 M2 relay 数据写进生产数据目录（跨变体污染）
    let data_dir = deck_root(&home).join("data").to_string_lossy().into_owned();
    let log = format!("{data_dir}/relay-service.log");
    let port = relay_port();
    let inject_env = if std::path::Path::new(&inject_cs).exists() {
        format!("    <key>CCR_INJECT_CS</key>\n    <string>{inject_cs}</string>\n")
    } else { String::new() };
    let label = relay_service_label();
    let plist = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{node}</string>
    <string>{script}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CCR_PORT</key>
    <string>{port}</string>
    <key>CCR_DATA_DIR</key>
    <string>{data_dir}</string>
{inject_env}    <key>CCR_NOHOOK_IDLE_MS</key>
    <string>60000</string>
    <key>PATH</key>
    <string>{home}/node/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#);
    let dir = std::path::Path::new(&home).join("Library").join("LaunchAgents");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 LaunchAgents 失败：{e}"))?;
    let path = dir.join(format!("{}.plist", relay_service_label()));
    std::fs::write(&path, plist).map_err(|e| format!("写 plist 失败：{e}"))?;
    Ok(path)
}

/// 服务化状态（设置页开关读）：supported=平台支持；enabled=launchd 已注册；
/// active=端口当前有 relay 在服务（无论谁属主）
#[tauri::command]
fn relay_service_status() -> Value {
    #[cfg(target_os = "macos")]
    {
        serde_json::json!({
            "supported": true,
            "enabled": relay_service_registered(),
            "active": port_listening(relay_port()),
        })
    }
    #[cfg(not(target_os = "macos"))]
    serde_json::json!({ "supported": false, "enabled": false, "active": port_listening(relay_port()) })
}

/// 服务化开关（阻塞最长约 8s 等 relay 起停，丢线程池防冻 UI）
#[tauri::command]
async fn relay_service_toggle(app: tauri::AppHandle, on: bool) -> Result<Value, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, on);
        return Err("此平台暂不支持 relay 服务化（Windows 版规划中）".into());
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || relay_service_toggle_sync(&app, on))
            .await
            .map_err(|e| format!("切换任务失败：{e}"))?
    }
}

#[cfg(target_os = "macos")]
fn relay_service_toggle_sync(app: &tauri::AppHandle, on: bool) -> Result<Value, String> {
    let uid = current_uid();
    let target = format!("gui/{uid}/{}", relay_service_label());
    let port = relay_port();
    if on {
        // 端口被非本方 relay 占着且服务未注册（插件 supervisor/手动实例）：硬上=服务
        // EADDRINUSE 崩溃循环。先停它再开（本方内嵌实例不算，下一步会被我们停掉）
        let ours = EMBEDDED_RELAY.lock().unwrap().is_some();
        if !ours && port_listening(port) && !relay_service_registered() {
            return Err("端口上的 relay 由外部程序托管——先停它再开启系统服务".into());
        }
        // ① 停本方内嵌实例（WANT 先撤防 supervisor 抢拉；kill 后端口空出）
        RELAY_WANTED.store(false, Ordering::SeqCst);
        if let Some(mut c) = EMBEDDED_RELAY.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
            println!("[relay-service] embedded instance stopped for handover");
        }
        // ② 写 plist + 幂等重挂 + 立即拉起
        let plist = write_relay_service_plist(app)?;
        let plist_str = plist.to_string_lossy().into_owned();
        let _ = launchctl(&["bootout", &target]); // 已注册时先摘（幂等）
        launchctl(&["bootstrap", &format!("gui/{uid}"), &plist_str])
            .map_err(|e| format!("launchd 注册失败：{e}"))?;
        let _ = launchctl(&["enable", &target]);
        launchctl(&["kickstart", "-k", &target])
            .map_err(|e| format!("launchd 拉起失败：{e}"))?;
        // ③ 等端口就绪（服务实例起 node ~1-2s）
        wait_port_ready(port, 8000);
        if !port_listening(port) {
            return Err("服务已注册但端口迟迟未就绪——看 ~/.cc-deck/data/relay-service.log".into());
        }
        // ④ WANT 复位：端口在服务，supervisor 只会让位不会重复拉
        RELAY_WANTED.store(true, Ordering::SeqCst);
        println!("[relay-service] enabled, service owns port {port}");
    } else {
        // 停用：bootout + 清 plist；WANT=true 让 supervisor 在端口空出后 1.5s 内
        // 自动重拉内嵌实例（无缝回退，用户无感）
        let _ = launchctl(&["bootout", &target]);
        let home = std::env::var("HOME").unwrap_or_default();
        let _ = std::fs::remove_file(
            std::path::Path::new(&home).join("Library").join("LaunchAgents").join(format!("{}.plist", relay_service_label())),
        );
        RELAY_WANTED.store(true, Ordering::SeqCst);
        wait_port_ready(port, 8000);
        println!("[relay-service] disabled, shell takes over port {port}");
    }
    Ok(relay_service_status())
}

/// 构建器按构建类型分流：单实例插件只在正式构建注册——dev 壳要与已装的正式版
/// 并行运行做联调（macOS 上该插件同 identifier 互踢：dev 实例启动即检测到正式版
/// 在跑，回调后自退，无法在装了正式版的机器上起 dev 壳自测）
#[cfg(not(debug_assertions))]
fn app_builder() -> tauri::Builder<tauri::Wry> {
    // 单实例插件须最先注册；二次启动（含参数不同）不另起窗口，唤起已有主窗口
    tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        show_main(app);
    }))
}
#[cfg(debug_assertions)]
fn app_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
}

fn main() {
    app_builder()
        .plugin(tauri_plugin_opener::init())
        // 在线更新（#319）：检查/下载/安装由 web-console ⚙ 关于区经 __TAURI__.updater 调用，
        // 签名公钥在 tauri.conf.json plugins.updater，签名的私钥经 CI Secrets 注入
        .plugin(tauri_plugin_updater::Builder::new().build())
        // #168 原生目录选择对话框：新建会话表单的「浏览」钮经 __TAURI__.dialog.open
        //（directory:true）调用；仅本机源可用（网页侧 guard），capabilities 放行 dialog:default
        .plugin(tauri_plugin_dialog::init())
        // #8 全局快捷键（呼出/收起）：默认键在 setup 注册，网页侧可经 set_toggle_shortcut 改绑
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![probe_local, open_external, open_path, probe_path, save_artifact, relay_status, relay_toggle, relay_service_status, relay_service_toggle, set_toggle_shortcut, app_version, ime_click, web_diag, web_fullscreen, storage_shadow_write, node_install])
        .setup(|app| {
            if build_tray(app).is_ok() {
                TRAY_OK.store(true, Ordering::SeqCst);
            }
            // #8 默认呼出/收起键（占用冲突不致命）：网页侧启动后按 localStorage 纠正
            //（改绑/清空都经 set_toggle_shortcut 覆盖这里的默认注册）
            if let Err(e) = register_toggle_shortcut(app.handle(), DEFAULT_TOGGLE_KEY) {
                println!("[shortcut] default {} 注册失败: {e}", DEFAULT_TOGGLE_KEY);
            }
            // #334 启动自动启用：本地无 relay 在服务就静默拉起内嵌 relay（已有则让位），
            // 等端口就绪再建窗口，保证页面首次探测（/local-info）即命中——用户全程无感
            // W15 让位分支补 WANT：启动时端口已有 relay（0.6.3 旧版壳/插件托管——nova 与
            // 旧版双装并排的常态）只直接连不另起；但旧版退出会带走 relay，WANT 不置真
            // 则监督线程判「别添乱」永不接管，壳当场掉线直到手动重启。置真后让位逻辑
            // 不变（端口在服务=need_spawn false 零动作），端口空出才补起内嵌实例
            //（与 #76 relay_service 停用回退同语义）
            if !port_listening(relay_port()) {
                match spawn_embedded_relay(app.handle()) {
                    // #17 首启预算 4s→9s：全新安装机器上 Defender 冷扫描 2MB relay.mjs
                    // + node 冷启动可超 4s；页面侧另有 90s 自愈重探兜底
                    Ok(()) => {
                        RELAY_WANTED.store(true, Ordering::SeqCst);
                        wait_port_ready(relay_port(), 9000);
                        // 起后即退（#17 同事实机：Node14 跑 node20 目标包 SyntaxError）——
                        // 原因透给状态行，不再只有「未检测到」
                        let died = EMBEDDED_RELAY.lock().unwrap().is_none() && !port_listening(relay_port());
                        if died {
                            *EMBEDDED_RELAY_ERR.lock().unwrap() = Some(
                                "内置 relay 启动后即退出——多为 Node.js 版本过旧，请升级到 20 LTS 后重启 CC Deck（详见 ~/.cc-deck/data/embedded-relay.log）".into(),
                            );
                        }
                    }
                    Err(e) => {
                        println!("[embedded-relay] auto-enable failed: {e}");
                        *EMBEDDED_RELAY_ERR.lock().unwrap() = Some(e);
                    }
                }
            } else {
                RELAY_WANTED.store(true, Ordering::SeqCst);
                println!("[embedded-relay] port {} already serving at boot - takeover armed", relay_port());
            }
            // #66 子进程监督常驻（WANT 门控：从未启用/用户手动停时静默空转）
            supervise_embedded_relay(app.handle().clone());
            // W-NOVAVAR B2（W-AUDIT-CONTRACT P1-2）：nova 变体壳侧标记。判定走运行时
            // config.identifier（--config overlay 在构建期已 merge 进 generate_context!：
            // 标准 = online.humumu.ccdeck.tauri / nova = online.humumu.ccdeck.nova）——
            // 不引环境变量/Cargo feature，nova overlay 就是唯一事实源。页面侧
            // （index-005.html）据 window.__CCDECK_NOVA 追加挂 nova-tauri 类：自绘三钮等
            // decorations=false 专属 UI 只认 .nova-tauri，标准 Windows 壳（系统标题栏，
            // 用户拍板 tauri.windows.conf.json decorations:true）不被 win-tauri 泛匹配
            // 误开——双标题栏回归根修。initialization_script 在页面任何脚本前执行，
            // 标记先于类挂载 IIFE 就位。
            let nova_marker = if app.config().identifier.ends_with(".nova") {
                "\nwindow.__CCDECK_NOVA = 1; // W-NOVAVAR B2: nova variant marker（decorations=false 壳专属 UI 开关）"
            } else {
                ""
            };
            // W-MIG 种子注入：影子备份存在且非空对象时，把对象字面量塞进 __CCDECK_SHADOW
            //（置于 INIT_SCRIPT 之前——恢复块在同串内先赋值后消费）。JSON 对象字面量即合法
            // JS 表达式（serde 已转义控制字符）；U+2028/2029 补转义兼容老引擎
            let shadow_seed = read_storage_shadow()
                .map(|v| {
                    let json = serde_json::to_string(&v).unwrap_or_default();
                    format!(
                        "window.__CCDECK_SHADOW = {};\n",
                        json.replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029")
                    )
                })
                .unwrap_or_default();
            let init_script = format!("{shadow_seed}{INIT_SCRIPT}{nova_marker}");
            let win = tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .initialization_script(&init_script)
                // 只允许壳内源；等价 Electron will-navigate 的本地白名单（防页面被导航带离）。
                // 平台差异（#72 mac 白屏根因）：Windows/Linux 是 http://tauri.localhost
                // （host=tauri.localhost），macOS 是 tauri://localhost（scheme=tauri、
                // host=localhost）——旧写法只认前者，mac 首次导航即被拦 → WebView
                // 透明不渲染，窗口只剩壁纸
                .on_navigation(|url| {
                    // W-UIPOLISH ②：白名单补 127.0.0.1——tauri dev 内置 server 的 frontendDist
                    // 形态是 http://127.0.0.1/index-005.html（[nav] 日志实锤），原白名单只认
                    // tauri.localhost / localhost+tauri scheme → dev 壳初始导航被拦 = 透明空窗
                    //（页面 INIT_SCRIPT/load 全不跑、webview 零内容）。回环地址与 localhost
                    // 信任等价（壳内资产形态，外站无法伪装 host）；release bundle 不受影响
                    //（tauri://localhost 原路径照旧）
                    println!("[nav] {}://{}{}", url.scheme(), url.host_str().unwrap_or("-"), url.path());
                    match url.host_str() {
                        Some("tauri.localhost") => true,
                        Some("localhost") => url.scheme() == "tauri",
                        Some("127.0.0.1") => url.scheme() == "http",
                        _ => false,
                    }
                })
                .build()?;
            // W-UIFIX B：窗口尺寸/位置记忆恢复（conf 默认 1280×800（W-UIPOLISH4 件七：原 1440×900 偏大）建窗后立即套用，
            // 有状态文件且位置可见才覆盖——同帧生效用户无感）
            restore_window_state(&win);            // #344 网易云式无边框：conf 的 decorations=false 在 from_config 路径实测未生效
            //（窗口样式仍带 WS_CAPTION），此处显式去框兜底；标题栏职责移交网页自绘。
            // #74 mac 例外：走 tauri.macos.conf 的 Overlay（系统红黄绿 + 内容全幅），
            // 这里再 set false 会把圆点一起扒掉——mac 跳过。
            // W15 Windows 例外（用户拍板「系统标准标题栏，最稳」）：tauri.windows.conf.json
            // 覆盖 decorations=true，此处不再去框——无框窗在 Windows 的拖拽/缩放边/贴边
            // 快照各有一堆边角（0.7.0-test.3 装机实测拖不动+顶栏残留），系统标题栏一并
            // 根治；网页侧 windowbar 退化为工具条（win 按钮与 mac 圆点都不再显示）
            if cfg!(not(any(target_os = "macos", target_os = "windows"))) {
                let _ = win.set_decorations(false);
            }
            // #74 第七轮：红黄绿圆点离窗口角（用户两轮反馈「太靠左上」）——系统默认
            // origin(7,6) 贴角；decorum 编程重定位到侧栏头部留白区（Electron app 同款
            // 手法）。网页侧 #sideHead 让位高度 38px 与此对应，改动需联动
            #[cfg(target_os = "macos")]
            {
                // W-UIPOLISH ②：nova 变体跳过 decorum 灯位重排——nova 用页面自绘三钮
                //（W-TEST11，html.mac-tauri.nova-tauri .window-dots），系统灯不存在，
                // inset 无的放矢；且 W-UIPOLISH ② 起 nova 窗口 transparent:true，
                // decorum 对透明窗口的 titlebar view 操作摸 nil（cocoa setAutoresizingMask_
                // null deref，二分实验实锤：关 inset 即稳）。标准 mac 壳（Overlay 系统灯）保留
                if !app.config().identifier.ends_with(".nova") {
                    use tauri_plugin_decorum::WebviewWindowExt;
                    let _ = win.set_traffic_lights_inset(16.0, 18.0);
                }
            }
            Ok(())
        })
        // 关窗到托盘（等价 Electron 的 close -> preventDefault + hide）；
        // 真退出（托盘退出/无托盘直关）时带走内嵌 relay，不留孤儿 node
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // W-UIFIX B：hide 到托盘/真退出前都先存窗口状态（mac 常态关窗口，尺寸保鲜）
                save_window_state(window.app_handle());
                if !QUITTING.load(Ordering::SeqCst) && TRAY_OK.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    kill_embedded_relay();
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if QUITTING.load(Ordering::SeqCst) {
                    kill_embedded_relay();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("CC Deck Tauri 壳构建失败")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // W-UIFIX B：app 级退出（托盘退出/Dock 退出）兜底存窗口状态——
                // 此时窗口对象尚存；Exit 阶段窗口已销毁拿不到尺寸
                save_window_state(app_handle);
            }
            if let tauri::RunEvent::Exit = event {
                kill_embedded_relay();
                let _ = app_handle;
            }
        });
}

#[cfg(test)]
mod t1a_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn t1a_probe_report() {
        let mut failures = 0;
        let mut check = |label: &str, passed: bool| {
            if passed {
                println!("t1a {label}: ok");
            } else {
                failures += 1;
                println!("t1a {label}: fail");
            }
        };

        let temp_root = std::env::temp_dir().join(format!(
            "cc-deck-t1a-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before unix epoch")
                .as_nanos()
        ));
        let resource_root = temp_root.join("bundle");
        std::fs::create_dir_all(resource_root.join("resources/bin")).expect("create probe resources");
        std::fs::write(resource_root.join("resources/relay.mjs"), b"// probe").expect("write relay fixture");
        std::fs::write(resource_root.join("resources/bin/inject.cs"), b"// probe").expect("write inject fixture");

        let present = probe_embedded_relay_resources(&resource_root);
        check(
            "resource present",
            present.script == ResourceState::Present && present.inject_cs == ResourceState::Present,
        );

        std::fs::remove_file(resource_root.join("resources/relay.mjs")).expect("remove relay fixture");
        let missing = probe_embedded_relay_resources(&resource_root);
        check("resource missing", missing.script == ResourceState::Missing);
        check(
            "resource invalid path",
            probe_resource_path(Path::new("relative/resources/relay.mjs")) == ResourceState::InvalidPath,
        );

        let free_probe = probe_relay_port(0);
        check(
            "port available",
            free_probe.owner == RelayPortOwner::Available
                && free_probe.conclusion() == "端口 0 空闲",
        );
        check(
            "port self relay",
            classify_relay_port(true, true, false) == RelayPortOwner::EmbeddedRelay,
        );
        check(
            "port external relay handshake",
            classify_relay_port(true, false, true) == RelayPortOwner::ExternalRelay,
        );
        check(
            "port external process",
            classify_relay_port(true, false, false) == RelayPortOwner::ExternalProcess,
        );

        let contracts = relay_dev_contracts();
        let data_dir = temp_root.join("data");
        let inject_cs = temp_root.join("inject.cs");
        let production_env = relay_spawn_env(contracts[0].default_port, &data_dir, &inject_cs, 42);
        let m2_env = relay_spawn_env(contracts[1].default_port, &data_dir, &inject_cs, 42);
        let env_value = |envs: &[(String, String)], key: &str| {
            envs.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone())
        };
        check(
            "spawn production default 8787",
            contracts[0].name == "production" && contracts[0].default_port == PRODUCTION_RELAY_PORT,
        );
        check(
            "spawn M2 default 8788",
            contracts[1].name == "M2" && contracts[1].default_port == M2_RELAY_PORT,
        );
        check(
            "spawn production CCR_PORT",
            contracts[0].port_env == "CCR_PORT"
                && env_value(&production_env, contracts[0].port_env) == Some("8787".to_string()),
        );
        check(
            "spawn M2 CCR_PORT",
            contracts[1].port_env == "CCR_PORT"
                && env_value(&m2_env, contracts[1].port_env) == Some("8788".to_string()),
        );
        check(
            "spawn production CCR_DATA_DIR",
            contracts[0].data_dir_env == "CCR_DATA_DIR"
                && env_value(&production_env, contracts[0].data_dir_env)
                    == data_dir.to_str().map(str::to_owned),
        );
        check(
            "spawn M2 CCR_DATA_DIR",
            contracts[1].data_dir_env == "CCR_DATA_DIR"
                && env_value(&m2_env, contracts[1].data_dir_env)
                    == data_dir.to_str().map(str::to_owned),
        );

        let _ = std::fs::remove_dir_all(&temp_root);
        println!("t1a summary: ok={} fail={}", 13 - failures, failures);
        assert_eq!(failures, 0, "T1a probe failures");
    }
}

// #018-T2 平台差异/资源契约 Rust 侧探针（cargo test --bin cc-deck-desktop-tauri t2_probe；
// node 直跑对照面见 tests/t2-probes.mjs）。只测纯函数与静态结构——需要 GUI/AppHandle
// 的路径（tray/窗口装饰/launchd 真注册）归 T3 装机批。
#[cfg(test)]
mod t2_tests {
    use super::*;

    #[test]
    fn relay_service_label_variant() {
        // G1（W-SVCDESIGN 2026-10-10）：label 随 M2_BUILD 变体化，防双变体互覆写
        // plist / bootout 互删。构建期常量判定，这里只锁「非空 + 后缀形状」。
        let l = relay_service_label();
        assert!(l.starts_with("online.humumu.ccdeck"));
        assert_eq!(l.ends_with(".m2.relay"), M2_BUILD);
    }

    #[test]
    fn t2_probe_report() {
        let mut failures = 0;
        let mut check = |label: &str, passed: bool| {
            if passed {
                println!("t2 {label}: ok");
            } else {
                failures += 1;
                println!("t2 {label}: fail");
            }
        };

        // 平台差异·盘点锁：危险扩展清单跨平台一致（#29 C-P2-2 双平台同守卫）
        check("dangerous_ext: Windows/mac 双平台危险扩展全拒（大小写不敏感）",
            dangerous_ext("evil.bat") && dangerous_ext("EVIL.SH") && dangerous_ext("x.Js")
                && dangerous_ext("malware.app") && dangerous_ext("a.b.exe"));
        check("dangerous_ext: 普通交付物放行（md/无扩展名/空串）",
            !dangerous_ext("报告.md") && !dangerous_ext("noext") && !dangerous_ext(""));

        // 平台差异·盘点锁：home 根随变体隔离（M2 构建 → .cc-deck-m2；生产 → .cc-deck 不变）
        let expected_root = if M2_BUILD { ".cc-deck-m2" } else { ".cc-deck" };
        check("deck_root: 数据根随构建变体隔离（plist 服务化 data_dir 同源）",
            deck_root("/home/u").ends_with(expected_root));

        // 平台差异·盘点锁：Windows \\?\ verbatim 前缀剥除（canonicalize 产物 node 不认）
        let verbatim = std::path::PathBuf::from(r"\\?\C:\Users\u\app\resources\relay.mjs");
        check("absolute_resource_path: 剥 \\\\?\\ verbatim 前缀（Windows canonicalize 形态）",
            absolute_resource_path(verbatim).to_string_lossy().starts_with("C:"));

        // 资源加载·握手分界：真 TCP 上 ExternalRelay（回 {"ok":true}）vs ExternalProcess（非 relay 回包）
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind probe port");
        let port = listener.local_addr().expect("local addr").port();
        let server = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
                let mut buf = [0u8; 512];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let _ = std::io::Write::write_all(
                    &mut stream,
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}",
                );
            }
        });
        check("relay_handshake: relay 形应答 → ExternalRelay 判定", relay_handshake(port));
        let _ = server.join();
        check("classify: listening+handshake → ExternalRelay（外部托管 relay 让位不抢）",
            classify_relay_port(true, false, true) == RelayPortOwner::ExternalRelay);

        println!("t2 summary: ok={} fail={}", 6 - failures, failures);
        assert_eq!(failures, 0, "T2 probe failures");
    }
}

// ── #206 测试：找包序优先级 + node_dist_download 全链（真下载校验解压） ──
#[cfg(test)]
mod node_tests {
    use super::*;

    #[test]
    fn relay_node_path_prefers_appdata() {
        // 临时 HOME 造 app-data/node/bin/node：relay_node_path 必命中它（优先级 ①）
        let tmp = std::env::temp_dir().join(format!("ccdeck-nodetest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let home = tmp.join("home");
        std::fs::create_dir_all(home.join(".cc-deck").join("app-data").join("node").join("bin")).unwrap();
        let bin = home.join(".cc-deck").join("app-data").join("node").join("bin").join("node");
        std::fs::write(&bin, b"#!/bin/sh\nexit 0").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::env::set_var("HOME", &home);
        assert_eq!(relay_node_path(), Some(bin.clone()));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    #[ignore] // 真下载 30MB（网络+时长）——CI/本地显式 --ignored 跑
    fn node_dist_download_full_chain() {
        let tmp = std::env::temp_dir().join(format!("ccdeck-nodedl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("HOME", &tmp);
        let bin = node_dist_download(tmp.to_str().unwrap()).expect("download+verify+extract 全链");
        assert!(bin.is_file());
        let out = std::process::Command::new(&bin).arg("--version").output().unwrap();
        assert!(out.status.success(), "内置 node 可执行");
        assert!(String::from_utf8_lossy(&out.stdout).contains("v22"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
