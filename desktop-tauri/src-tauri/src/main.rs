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
//   捕获阶段拦截 a[target=_blank] + window.open，http(s) 走 open_external 命令 →
//   tauri-plugin-opener 唤系统浏览器；on_navigation 只放行 tauri.localhost 源，
//   等价 Electron 的 will-navigate 白名单。
// - 暂缺（与 Electron 的差异）：--smoke 冒烟模式（CI 侧用 Electron 包覆盖）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::Manager;
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
const INIT_SCRIPT: &str = r#"
if (!window.ccDeck) {
  window.ccDeck = {
    probeLocal: () => window.__TAURI__.core.invoke("probe_local"),
    openExternal: (url) => window.__TAURI__.core.invoke("open_external", { url }),
    openPath: (path, reveal) => window.__TAURI__.core.invoke("open_path", { path, reveal }),
    relayCtl: true, // 标记：内置 relay 开关能力存在（网页端据此显示设置行）
    relayStatus: () => window.__TAURI__.core.invoke("relay_status"),
    relayToggle: (on) => window.__TAURI__.core.invoke("relay_toggle", { on }),
  };
}
document.addEventListener("click", (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
  if (a && /^https?:/i.test(a.href)) {
    e.preventDefault();
    window.ccDeck.openExternal(a.href).catch(() => {});
  }
}, true);
window.open = (url) => {
  window.ccDeck.openExternal(String(url)).catch(() => {});
  return null;
};
"#;

/// 本机 relay 探测（等价 Electron 的 cc-deck:probe-local）：
/// GET http://127.0.0.1:8787/local-info，1.5s 超时，返回 { ok, port, token } 或 null；
/// 失败静默（页面回退手动配置），不 panic 不弹错
#[tauri::command]
async fn probe_local() -> Option<Value> {
    const ENDPOINT: &str = "http://127.0.0.1:8787/local-info";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .ok()?;
    let resp = match client.get(ENDPOINT).send().await {
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
    if reveal {
        app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
    } else {
        app.opener().open_path(p, None::<&str>).map_err(|e| e.to_string())
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
        .tooltip("CC Deck")
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

fn relay_port() -> u16 {
    std::env::var("CCR_DESKTOP_RELAY_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8787)
}

fn port_listening(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

// node 探测只做 PATH 查找（不执行 node——Windows 商店的 WindowsApps 假别名 stub
// 会让 `node --version` 挂起不返回）。按平台分流：
// - Windows：where.exe；#13 路径含 WindowsApps（商店 stub）一律视为未装
// - macOS（#72）：GUI app 的 PATH 不含用户 shell 的自定义路径（~/node/bin 等），
//   which 大概率落空——枚举常见安装位置 + which 双通道
#[cfg(target_os = "windows")]
fn node_path() -> Option<std::path::PathBuf> {
    let out = std::process::Command::new("where").arg("node").output().ok()?;
    if !out.status.success() { return None; }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let first = line.trim();
        if first.is_empty() || first.to_ascii_lowercase().contains("windowsapps") { continue; }
        return Some(std::path::PathBuf::from(first));
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
    // ② GUI PATH 摸不到的用户安装位（zshrc 自定义 PATH 的常见形态）
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/node/bin/node"),
        format!("{home}/.nvm/current/bin/node"),
        "/usr/local/bin/node".to_string(),
        "/opt/homebrew/bin/node".to_string(),
        "/opt/local/bin/node".to_string(),
    ];
    for c in candidates {
        let p = std::path::PathBuf::from(&c);
        if p.exists() { return Some(p); }
    }
    None
}

fn node_in_path() -> bool {
    node_path().is_some()
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
    let abs = |p: std::path::PathBuf| {
        let c = std::fs::canonicalize(&p).unwrap_or(p);
        let mut s = c.to_string_lossy().into_owned();
        if let Some(t) = s.strip_prefix("\\\\?\\") {
            s = t.to_string();
        }
        std::path::PathBuf::from(s)
    };
    let script = abs(res.join("resources").join("relay.mjs"));
    let inject_cs = abs(res.join("resources").join("bin").join("inject.cs"));
    println!("[embedded-relay] script={}", script.display());
    if !script.exists() {
        return Err("内置 relay.mjs 缺失（安装包损坏？重装试试）".into());
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|_| "无法定位用户目录".to_string())?;
    let data_dir = std::path::Path::new(&home).join(".cc-deck").join("data");
    let _ = std::fs::create_dir_all(&data_dir);
    // #71 跨平台：CREATE_NO_WINDOW 是 Windows 专属（防 node 子进程闪 cmd 窗），
    // mac 上无此概念——cfg 门控按平台分流
    #[cfg(target_os = "windows")]
    fn spawn_relay(node: &std::path::Path, script: &std::path::Path, port: u16, data_dir: &std::path::Path, inject_cs: &std::path::Path, log: &std::path::Path) -> std::io::Result<std::process::Child> {
        use std::os::windows::process::CommandExt;
        let out = std::fs::File::create(log)?;
        std::process::Command::new(node)
            .arg(script)
            .env("CCR_PORT", port.to_string())
            .env("CCR_DATA_DIR", data_dir)
            .env("CCR_INJECT_CS", inject_cs)
            .env("CCR_NOHOOK_IDLE_MS", "60000")
            .env("CCR_PARENT_PID", std::process::id().to_string())
            .env_remove("NODE_OPTIONS")
            .stdout(out.try_clone()?)
            .stderr(out)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
    }
    #[cfg(not(target_os = "windows"))]
    fn spawn_relay(node: &std::path::Path, script: &std::path::Path, port: u16, data_dir: &std::path::Path, inject_cs: &std::path::Path, log: &std::path::Path) -> std::io::Result<std::process::Child> {
        let out = std::fs::File::create(log)?;
        std::process::Command::new(node)
            .arg(script)
            .env("CCR_PORT", port.to_string())
            .env("CCR_DATA_DIR", data_dir)
            .env("CCR_INJECT_CS", inject_cs)
            .env("CCR_NOHOOK_IDLE_MS", "60000")
            .env("CCR_PARENT_PID", std::process::id().to_string())
            .env_remove("NODE_OPTIONS")
            .stdout(out.try_clone()?)
            .stderr(out)
            .spawn()
    }
    let log = data_dir.join("embedded-relay.log");
    let node = node_path().ok_or(
        "未检测到 Node.js 运行时——内置 relay 需要它（VS Code 的 Claude Code 扩展自带运行时，不算已装）。请到 nodejs.org 安装 Node.js 后重启 CC Deck",
    )?;
    match spawn_relay(&node, &script, port, &data_dir, &inject_cs, &log)
    {
        Ok(child) => {
            println!("[embedded-relay] spawned pid={} port={}", child.id(), port);
            *EMBEDDED_RELAY.lock().unwrap() = Some(child);
            Ok(())
        }
        Err(e) => Err(format!("relay 启动失败（node 不在 PATH？）：{e}")),
    }
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

fn main() {
    tauri::Builder::default()
        // 单实例插件须最先注册；二次启动（含参数不同）不另起窗口，唤起已有主窗口
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        // 在线更新（#319）：检查/下载/安装由 web-console ⚙ 关于区经 __TAURI__.updater 调用，
        // 签名公钥在 tauri.conf.json plugins.updater，签名的私钥经 CI Secrets 注入
        .plugin(tauri_plugin_updater::Builder::new().build())
        // #8 全局快捷键（呼出/收起）：默认键在 setup 注册，网页侧可经 set_toggle_shortcut 改绑
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![probe_local, open_external, open_path, relay_status, relay_toggle, set_toggle_shortcut])
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
            }
            // #66 子进程监督常驻（WANT 门控：从未启用/用户手动停时静默空转）
            supervise_embedded_relay(app.handle().clone());
            let win = tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .initialization_script(INIT_SCRIPT)
                // 只允许壳内源；等价 Electron will-navigate 的本地白名单（防页面被导航带离）。
                // 平台差异（#72 mac 白屏根因）：Windows/Linux 是 http://tauri.localhost
                // （host=tauri.localhost），macOS 是 tauri://localhost（scheme=tauri、
                // host=localhost）——旧写法只认前者，mac 首次导航即被拦 → WebView
                // 透明不渲染，窗口只剩壁纸
                .on_navigation(|url| match url.host_str() {
                    Some("tauri.localhost") => true,
                    Some("localhost") => url.scheme() == "tauri",
                    _ => false,
                })
                .build()?;
            // #344 网易云式无边框：conf 的 decorations=false 在 from_config 路径实测未生效
            //（窗口样式仍带 WS_CAPTION），此处显式去框兜底；标题栏职责移交网页自绘。
            // #74 mac 例外：走 tauri.macos.conf 的 Overlay（系统红黄绿 + 内容全幅），
            // 这里再 set false 会把圆点一起扒掉——mac 跳过
            if !cfg!(target_os = "macos") {
                let _ = win.set_decorations(false);
            }
            // #74 第七轮：红黄绿圆点离窗口角（用户两轮反馈「太靠左上」）——系统默认
            // origin(7,6) 贴角；decorum 编程重定位到侧栏头部留白区（Electron app 同款
            // 手法）。网页侧 #sideHead 让位高度 38px 与此对应，改动需联动
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_decorum::WebviewWindowExt;
                let _ = win.set_traffic_lights_inset(16.0, 18.0);
            }
            Ok(())
        })
        // 关窗到托盘（等价 Electron 的 close -> preventDefault + hide）；
        // 真退出（托盘退出/无托盘直关）时带走内嵌 relay，不留孤儿 node
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
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
            if let tauri::RunEvent::Exit = event {
                kill_embedded_relay();
                let _ = app_handle;
            }
        });
}
