// CC Deck 桌面壳（Tauri 2）：加载打包内嵌的 web-console（frontendDist 指向 ../../web-console，
// 构建时整个目录烙进二进制），默认连本机 relay。与 desktop/（Electron 壳）并行共存，
// 产物名带 -tauri 区分；本机无 Rust 工具链，CI（desktop.yml build-tauri job）出包。
//
// 与 Electron 版（desktop/main.js）的对应关系与取舍：
// - 窗口参数：1200×800 / min 960×640 / 标题 CC Deck，在 tauri.conf.json 声明（create:false），
//   由 setup 用 from_config 接管创建——为的是挂 initialization_script（conf 不支持该字段）。
// - relay 探测：页面在 Tauri 下运行于 http://tauri.localhost 源，页面侧 fetch /local-info
//   会带该 Origin，进不了 relay 白名单（ws-server.ts hostTrusted 只认 localhost/127.0.0.1/
//   本机 LAN IP）→ 探测必须留在壳侧：本进程发请求不带 Origin，relay 走 Host 判定放行，
//   与 Electron 主进程同信任模型。经 initialization_script 注入 window.ccDeck.probeLocal
//   （与 Electron preload 同形），web-console/index.html 零改动即用。
// - 暂缺（第二步补）：托盘/关窗到托盘、单实例锁、外链走系统浏览器（页面 target=_blank 在
//   WebView2 内默认无动作，需 opener 插件）、--smoke 冒烟模式。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;

/// 页面启动前注入的桥（等价 desktop/preload.js）：probeLocalRelay 优先走 window.ccDeck
const INIT_SCRIPT: &str = r#"
if (!window.ccDeck) {
  window.ccDeck = {
    probeLocal: () => window.__TAURI__.core.invoke("probe_local"),
  };
}
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe_local])
        .setup(|app| {
            tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .initialization_script(INIT_SCRIPT)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("CC Deck Tauri 壳启动失败");
}
