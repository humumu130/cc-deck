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
use tauri_plugin_opener::OpenerExt;

/// 托盘菜单“退出”置位（否则关窗一律隐藏到托盘）
static QUITTING: AtomicBool = AtomicBool::new(false);
/// 托盘是否建成：图标缺失等失败时关窗直退，不留“隐身无出口”状态
static TRAY_OK: AtomicBool = AtomicBool::new(false);

/// 页面启动前注入的桥（等价 desktop/preload.js）：probeLocal 优先走 window.ccDeck；
/// 外链兜底：捕获阶段拦 target=_blank 与 window.open，转交壳侧系统浏览器打开
const INIT_SCRIPT: &str = r#"
if (!window.ccDeck) {
  window.ccDeck = {
    probeLocal: () => window.__TAURI__.core.invoke("probe_local"),
    openExternal: (url) => window.__TAURI__.core.invoke("open_external", { url }),
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

/// 唤起主窗口：show + unminimize + focus（等价 Electron 的 showWin）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
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

    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default_window_icon".into()))?
        .clone();

    TrayIconBuilder::with_id("cc-deck-tray")
        .icon(icon)
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

fn main() {
    tauri::Builder::default()
        // 单实例插件须最先注册；二次启动（含参数不同）不另起窗口，唤起已有主窗口
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![probe_local, open_external])
        .setup(|app| {
            if build_tray(app).is_ok() {
                TRAY_OK.store(true, Ordering::SeqCst);
            }
            tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .initialization_script(INIT_SCRIPT)
                // 只允许壳内源；等价 Electron will-navigate 的本地白名单（防页面被导航带离）
                .on_navigation(|url| url.host_str() == Some("tauri.localhost"))
                .build()?;
            Ok(())
        })
        // 关窗到托盘（等价 Electron 的 close -> preventDefault + hide）
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) && TRAY_OK.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("CC Deck Tauri 壳启动失败");
}
