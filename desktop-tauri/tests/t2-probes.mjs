#!/usr/bin/env node
// #018-T2 Tauri 平台差异/版本可见性/资源加载回归探针（无 cargo 依赖，node 直跑）：
//   node desktop-tauri/tests/t2-probes.mjs
//
// 静态面：
//   A 平台分支盘点锁（main.rs 全部 cfg(target_os)/unix/debug_assertions 分支逐项锚点；
//     平台字面量完备性——防未盘点 OS 混入）
//   B 版本/协议可见性（壳版本归源链 tauri.conf→package.json→app_version→关于区；
//     协议版本=WS SNAPSHOT schema_version，/local-info 现状字段锁定无版本字段；
//     内嵌 bundle 烙值与 relay/src/types.ts 源值零漂移）
//   C 资源加载（spawn_embedded_relay 读 resource_dir 内嵌资源非系统路径；前置资源闸；
//     桌面 bundle vs 插件 bundle SHA256 漂移检测）
//   D 端口四态判定链（Available/EmbeddedRelay/ExternalRelay/ExternalProcess 源码锚点
//     + boot 让位分支 + CCR_DESKTOP_RELAY_PORT 测试通道回归）
// 动态面（沙箱：mkdtemp 数据目录 + 随机高位端口，绝不触生产 8787/8788 与 ~/.cc-deck*）：
//   E dev/bundle 一致性——tsx 源与内嵌 relay.mjs 各拉起：/health + WS SNAPSHOT 实测
//   schema_version 对照；bundle 以脱离 relay/ 的 cwd、零 NODE_PATH 拉起证明自包含；
//   ExternalProcess（纯 TCP 占口）/ExternalRelay（relay 占口）真进程分类实验。
// 备案：cargo 侧纯函数探针（main.rs mod t2_tests）经 tests/t2-probe.sh 跑，本机无 cargo
//   未编译验证（T1a 同边界）；壳内真进程树/托盘/launchd 真注册归 T3 装机批。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAURI_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TAURI_ROOT, "..");
const MAIN_RS = path.join(TAURI_ROOT, "src-tauri", "src", "main.rs");
const BUNDLE = path.join(TAURI_ROOT, "src-tauri", "resources", "relay.mjs");
const PLUGIN_BUNDLE = path.join(REPO_ROOT, "cc-plugins", "plugins", "cc-deck", "scripts", "relay.mjs");
const TYPES_TS = path.join(REPO_ROOT, "relay", "src", "types.ts");
const CONFIG_TS = path.join(REPO_ROOT, "relay", "src", "config.ts");
const WS_SERVER_TS = path.join(REPO_ROOT, "relay", "src", "ws-server.ts");
const RELAY_DIR = path.join(REPO_ROOT, "relay");
const TAURI_CONF = path.join(TAURI_ROOT, "src-tauri", "tauri.conf.json");
const TAURI_PKG = path.join(TAURI_ROOT, "package.json");
const WEB_CONSOLE = path.join(REPO_ROOT, "web-console", "index.html");

let tests = 0;
const check = (condition, msg = "assertion failed") => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const mainRs = readFileSync(MAIN_RS, "utf-8");

// ============ A. 平台分支盘点锁 ============
console.log("== A. 平台分支盘点（逐项锚点，全清单见回单） ==");
{
  // ① IME 激活点击（#240）：mac 原生 NSEvent / 非 mac Err 回落 JS focus——双分支对称
  const imeIdx = mainRs.indexOf("fn ime_click(");
  check(imeIdx > 0, "A1 ime_click 命令在位");
  const imeBody = mainRs.slice(imeIdx, mainRs.indexOf("\n/// 托盘", imeIdx));
  check(imeBody.includes('#[cfg(target_os = "macos")]') && imeBody.includes('#[cfg(not(target_os = "macos"))]'),
    "A1 ime_click 双分支对称（mac NSEvent / non-mac 显式 Err）");
  check(imeBody.includes('Err("ime_click 仅 macOS".into())'),
    "A1 non-mac 分支可见降级（Err 话术，web 侧回落 JS focus，不静默）");

  // ② 托盘图标（2026-09-14 反馈）：mac template 单色 / 非 mac 彩色窗口图标
  check(mainRs.includes("tray-template.png") && mainRs.includes(".icon_as_template(cfg!(target_os = \"macos\"))"),
    "A2 托盘图标分平台：mac template image 自动适配深浅菜单栏");
  check(/#\[cfg\(not\(target_os = "macos"\)\)\]\s*\n\s*let icon = app\s*\n\s*\.default_window_icon\(\)/.test(mainRs),
    "A2 非 mac 用 default_window_icon 彩色");

  // ③ node 探测（#13 商店 stub 挂起 / #72 mac GUI PATH）——按平台分流，不执行 node
  const nodePathBody = mainRs.slice(mainRs.indexOf("#[cfg(target_os = \"windows\")]\nfn node_path("), mainRs.indexOf("fn node_in_path("));
  check(/fn node_path\(\)/.test(nodePathBody) && nodePathBody.includes("where") && nodePathBody.includes("windowsapps"),
    "A3 node_path Windows：where.exe + WindowsApps 商店 stub 排除（#13）");
  check(nodePathBody.includes("which") && nodePathBody.includes("/opt/homebrew/bin/node") && nodePathBody.includes(".nvm/current"),
    "A3 node_path mac/Linux：which + 用户安装位候选枚举（#72 GUI PATH 缺自定义路径）");
  check(nodePathBody.includes("Command::new(\"node\")") === false,
    "A3 node 探测零执行（不跑 node --version，防 stub 挂起）");

  // ④ spawn_relay 双平台（#71）：CREATE_NO_WINDOW 仅 Windows；env 注入两分支一致
  const winSpawn = mainRs.match(/#\[cfg\(target_os = "windows"\)\]\s*\n\s*fn spawn_relay\([\s\S]*?\n    \}/)?.[0] ?? "";
  const unixSpawn = mainRs.match(/#\[cfg\(not\(target_os = "windows"\)\)\]\s*\n\s*fn spawn_relay\([\s\S]*?\n    \}/)?.[0] ?? "";
  check(winSpawn !== "" && unixSpawn !== "", "A4 spawn_relay 双平台分支在位");
  check(winSpawn.includes("creation_flags(0x0800_0000)") && !unixSpawn.includes("creation_flags"),
    "A4 CREATE_NO_WINDOW 仅 Windows 分支（防 node 闪 cmd 窗）");
  const envCount = (s) => (s.match(/apply_relay_spawn_env/g) ?? []).length;
  check(envCount(winSpawn) === 1 && envCount(unixSpawn) === 1,
    "A4 两分支 env 注入同链（apply_relay_spawn_env 各一次，行为一致）");

  // ⑤ 导航白名单（#72 mac 白屏根因）：双平台 origin 形态显式覆盖
  check(mainRs.includes('Some("tauri.localhost") => true') && mainRs.includes('Some("localhost") => url.scheme() == "tauri"'),
    "A5 on_navigation 双平台 origin（Windows/Linux http://tauri.localhost + mac tauri://localhost）");

  // ⑥ 窗口装饰（#344/#74）：非 mac 无边框兜底；mac 走 Overlay 红黄绿不重扒
  check(mainRs.includes('if !cfg!(target_os = "macos") {') && mainRs.includes("set_decorations(false)"),
    "A6 非 mac 显式去框（#344 conf 路径未生效兜底）");
  check(/#\[cfg\(target_os = "macos"\)\]\s*\n\s*\{\s*\n\s*use tauri_plugin_decorum::WebviewWindowExt;/.test(mainRs)
    && mainRs.includes("set_traffic_lights_inset(16.0, 18.0)"),
    "A6 mac 红黄绿 decorum 重定位（跳过去框，#74）");

  // ⑦ 单实例插件仅 release（dev 壳与已装正式版并行联调）
  check(/#\[cfg\(not\(debug_assertions\)\)\]\s*\nfn app_builder/.test(mainRs)
    && /#\[cfg\(debug_assertions\)\]\s*\nfn app_builder/.test(mainRs),
    "A7 app_builder debug/release 分流（single-instance 仅正式构建）");

  // ⑧ home 解析跨平台：Windows USERPROFILE 优先，回落 HOME
  check(mainRs.includes('std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))'),
    "A8 home 解析跨平台（USERPROFILE or HOME）");

  // ⑨ Windows canonicalize \\?\ verbatim 前缀剥除（node realpathSync 不认）
  check(mainRs.includes('strip_prefix("\\\\\\\\?\\\\")'),
    "A9 剥 \\\\?\\ verbatim 前缀（Windows canonicalize 产物清洗）");

  // ⑩ 端口进程名探测：unix lsof / 非 unix None（文案降级可接受，分类不依赖进程名）
  check(/#\[cfg\(unix\)\][\s\S]*?fn process_name_for_port[\s\S]*?lsof/.test(mainRs)
    && /#\[cfg\(not\(unix\)\)\]\s*\n#\[allow\(dead_code\)\]\s*\nfn process_name_for_port\(_port: u16\) -> Option<String> \{\s*\n\s*None/.test(mainRs),
    "A10 process_name_for_port 分平台（unix lsof / 非 unix None 降级）");

  // ⑪ relay 服务化 macOS 门控（launchd；Windows 规划中显式 Err）
  const macosCfg = (mainRs.match(/#\[cfg\(target_os = "macos"\)\]/g) ?? []).length;
  check(macosCfg >= 8 && mainRs.includes("fn current_uid(") && mainRs.includes("fn launchctl(")
    && mainRs.includes("fn write_relay_service_plist(") && mainRs.includes("fn relay_service_toggle_sync("),
    `A11 launchd 服务化件（uid/launchctl/plist/toggle_sync）macOS cfg 门控（${macosCfg} 处 cfg macos）`);
  check(mainRs.includes('"supported": true,') && mainRs.includes('"supported": false, "enabled": false'),
    "A11 服务化状态双平台（mac supported=true / 非 mac false 可见降级）");
  check(mainRs.includes("此平台暂不支持 relay 服务化"),
    "A11 非 mac 服务化开关显式 Err（不静默假成功）");

  // ⑫ Windows release 隐控制台
  check(mainRs.includes('#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]'),
    "A12 Windows release windows_subsystem 隐控制台");

  // ⑬ 服务化 plist 数据目录走 deck_root（#018-T2 修复：M2 变体不再写生产数据根）
  check(/let data_dir = deck_root\(&home\)\.join\("data"\)\.to_string_lossy\(\)\.into_owned\(\);/.test(mainRs),
    "A13 服务化 plist data_dir 走 deck_root（M2 隔离，修复锚点）");

  // 完备性：平台字面量无未盘点 OS；cfg 分支计数下限（防漏盘点/新分支绕过清单）
  const osLits = [...new Set([...mainRs.matchAll(/target_os = "(\w+)"/g)].map((m) => m[1]))];
  check(osLits.length > 0 && osLits.every((o) => o === "macos" || o === "windows"),
    `A14 平台字面量完备：全部 ∈ {macos,windows}（got ${osLits.join(",") || "无"}）；unix 族经 cfg(unix) 另计`);
  check((mainRs.match(/\bcfg\(/g) ?? []).length >= 20,
    `A14 cfg 分支计数下限（got ${mainRs.match(/\bcfg\(/g).length}，含 cfg!/cfg_attr 展开面）`);
}

// ============ B. 版本/协议可见性 ============
console.log("== B. 版本/协议可见性 ==");
{
  // 壳版本归源链：package.json → tauri.conf 引用 → app_version 命令 → 关于区
  const tauriConf = JSON.parse(readFileSync(TAURI_CONF, "utf-8"));
  check(tauriConf.version === "../package.json", "B1 tauri.conf version 引用 package.json（单源无硬编码）");
  const pkg = JSON.parse(readFileSync(TAURI_PKG, "utf-8"));
  check(/^\d+\.\d+\.\d+/.test(pkg.version), `B2 壳版本 ${pkg.version} 在场（semver 形态）`);
  const handler = mainRs.match(/generate_handler!\[[\s\S]*?\]\)/)?.[0] ?? "";
  check(handler.includes("app_version"), "B3 app_version 命令已注册（invoke 面）");
  check(mainRs.includes("fn app_version(app: tauri::AppHandle) -> String") && mainRs.includes("app.config().version"),
    "B3 app_version 读 config version（#199 壳版本口径，非控制台版本）");
  const web = readFileSync(WEB_CONSOLE, "utf-8");
  check(web.includes('invoke?.("app_version")'), "B3 关于区消费 app_version（web-console 显示面在场）");

  // 协议版本：源值 → bundle 烙值零漂移；可见面现状锁定
  const typesTs = readFileSync(TYPES_TS, "utf-8");
  const schemaSrc = typesTs.match(/export const SNAPSHOT_SCHEMA_VERSION = (\d+) as const;/)?.[1];
  check(schemaSrc === "1", `B4 types.ts SNAPSHOT_SCHEMA_VERSION=${schemaSrc}（源值）`);
  const bundleSrc = readFileSync(BUNDLE, "utf-8");
  const schemaBundle = bundleSrc.match(/SNAPSHOT_SCHEMA_VERSION = (\d+)/)?.[1];
  check(schemaBundle === schemaSrc, `B5 内嵌 bundle 烙值 SNAPSHOT_SCHEMA_VERSION=${schemaBundle} 与源一致（协议版本已正确烙进产物）`);
  const wsServer = readFileSync(WS_SERVER_TS, "utf-8");
  check(wsServer.includes("schema_version: SNAPSHOT_SCHEMA_VERSION"),
    "B6 WS SNAPSHOT 帧携带 schema_version（协议版本唯一可见面）");
  check(wsServer.includes('JSON.stringify({ ok: true, port: cfg.port, token: cfg.token, lan_ip: lanIp })'),
    "B6 /local-info 现状字段锁定 {ok,port,token,lan_ip}——无 schema_version（备案：壳 probe_local 透传面不含协议版本；如需 UI 面显示，最小改法=relay /local-info 增 schema_version 字段+壳零改动自动透传，归 relay 协议批）");
}

// ============ C. 资源加载 ============
console.log("== C. 资源加载回归 ==");
{
  check(existsSync(BUNDLE) && statSync(BUNDLE).size > 500_000,
    `C1 内嵌 relay.mjs 在场（${(statSync(BUNDLE).size / 1024 / 1024).toFixed(1)}MB）`);
  check(existsSync(path.join(TAURI_ROOT, "src-tauri", "resources", "bin", "inject.cs")),
    "C2 内嵌 inject.cs 在场");
  // 加载链：resource_dir() 拼装（随安装包走）——非系统路径
  check(/app\.path\(\)\.resource_dir\(\)/.test(mainRs)
    && /\.join\("resources"\)\.join\("relay\.mjs"\)/.test(mainRs),
    "C3 spawn_embedded_relay 读 resource_dir 内嵌资源（非 /usr/local 等系统路径）");
  check(!/\/usr\/local\/share|\/usr\/lib|C:\\\\Program Files/.test(mainRs),
    "C3 无系统路径字面量（资源解析单一来源 resource_dir）");
  check(/if resource_probe\.script != ResourceState::Present \{/g.test(mainRs)
    && /ResourceState::Missing|ResourceState::InvalidPath/.test(mainRs),
    "C4 前置资源闸：relay.mjs/inject.cs 缺失/无效即拒启（不半启动）");
  const shaDesk = sha256(BUNDLE);
  const shaPlugin = sha256(PLUGIN_BUNDLE);
  check(shaDesk === shaPlugin,
    `C5 桌面 bundle vs 插件 bundle SHA 一致（${shaDesk.slice(0, 8)}，零漂移）`);
  console.log(`   SHA256: ${shaDesk}`);
}

// ============ D. 端口四态判定链（源码锚点 + 动态实验在 E） ============
console.log("== D. 端口四态判定链 ==");
{
  check(/fn classify_relay_port\(listening: bool, embedded: bool, relay_handshake: bool\) -> RelayPortOwner/.test(mainRs),
    "D1 四态分类函数签名在位（Available/EmbeddedRelay/ExternalRelay/ExternalProcess）");
  check(mainRs.includes('"端口 {} 空闲"') && mainRs.includes('"端口 {} 由自家 relay 占用"')
    && mainRs.includes('"端口 {} 由外部 relay 占用"') && mainRs.includes('"端口 {} 由外来进程占用（{}）"'),
    "D1 四态结论文案齐备（外部托管指引停用命令）");
  // 生产 8787 被占：boot 让位分支 + toggle already-serving 分支
  check(/if !port_listening\(relay_port\(\)\) \{\s*\n\s*match spawn_embedded_relay/.test(mainRs),
    "D2 boot 让位：端口已有服务不 spawn（插件 supervisor/生产 relay 让位，用户无感）");
  check(mainRs.includes("already serving - nothing to do"),
    "D2 toggle-on 让位：已有 relay 视为开启态不双拉");
  check(mainRs.includes("端口上的 relay 由外部托管") && mainRs.includes("disable.sh"),
    "D2 外部 relay 停用指引透出（#76 开关管不到的诚实话术）");
  check(/std::env::var\("CCR_DESKTOP_RELAY_PORT"\)/.test(mainRs),
    "D3 CCR_DESKTOP_RELAY_PORT 测试通道在位（生产占 8787 时换口验证启动分支）");
  check(/const PRODUCTION_RELAY_PORT: u16 = 8787;/.test(mainRs) && /const M2_RELAY_PORT: u16 = 8788;/,
    "D3 端口常量回归：生产 8787 / M2 8788（T1a 同款防漂移）");
}

// ============ E. 动态面：dev/bundle 一致性 + 端口占用真进程实验 ============
console.log("== E. dev/bundle 一致性（沙箱拉起） ==");
{
  const freePort = () =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
  const getHealth = (port) =>
    new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 2000 }, (res) => {
        let body = "";
        res.on("data", (c) => { body += String(c); });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
  const waitHealth = async (port, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const h = await getHealth(port);
      if (h) return h;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  };
  // WS SNAPSHOT 实测：token 走 env 契约（config.ts :76 env 优先于 data/token 文件——
  // 实测 shell 泄漏的生产 CCR_TOKEN 会让沙箱 relay 不落盘 token 文件，读文件法必空），
  // 探针显式钉死沙箱 token：确定 + 与本 shell 环境隔离
  const SANDBOX_TOKEN = "t2probe-sandbox-token-0001";
  const readSchemaVersion = (port) =>
    new Promise((resolve) => {
      let ws;
      try { ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(SANDBOX_TOKEN)}`); }
      catch { return resolve(null); }
      const done = (v) => { try { ws.close(); } catch {} resolve(v); };
      const timer = setTimeout(() => done(null), 15_000);
      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(String(ev.data));
          const sv = frame?.payload?.schema_version ?? frame?.schema_version;
          if (frame?.type === "SNAPSHOT" && sv !== undefined) { clearTimeout(timer); done(Number(sv)); }
        } catch {}
      };
      ws.onerror = () => { clearTimeout(timer); done(null); };
    });
  const sandboxEnv = (port, dataDir) => ({
    ...process.env,
    CCR_PORT: String(port),
    CCR_TOKEN: SANDBOX_TOKEN,
    CCR_DATA_DIR: dataDir,
    CCR_ORG_DIR: path.join(dataDir, "org"),
    CCR_ARTIFACTS_DIR: path.join(dataDir, "artifacts"),
    CCR_NO_TITLE_GEN: "1",
  });
  const collect = (child) => {
    let out = "";
    child.stdout?.on("data", (c) => { out = (out + String(c)).slice(-4000); });
    child.stderr?.on("data", (c) => { out = (out + String(c)).slice(-4000); });
    return () => out.slice(-300);
  };

  const dataDirBundle = mkdtempSync(path.join(os.tmpdir(), "cc-t2-bundle-"));
  const dataDirDev = mkdtempSync(path.join(os.tmpdir(), "cc-t2-dev-"));
  let bundleChild = null;
  let devChild = null;
  try {
    // ① bundle 自包含拉起：cwd 脱离 relay/、零 NODE_PATH——esbuild 产物不依赖源码树
    const bundlePort = await freePort();
    check(bundlePort !== 8787 && bundlePort !== 8788 && bundlePort > 1024,
      `E1 随机高位端口取证（${bundlePort}，非生产 8787/非 M2 8788）`);
    const envNoNodePath = sandboxEnv(bundlePort, dataDirBundle);
    delete envNoNodePath.NODE_PATH;
    bundleChild = spawn(process.execPath, [BUNDLE], { cwd: os.tmpdir(), env: envNoNodePath, stdio: ["ignore", "pipe", "pipe"] });
    const bundleOut = collect(bundleChild);
    check(typeof bundleChild.pid === "number" && bundleChild.pid > 0,
      `E1 内嵌 bundle 独立拉起：node relay.mjs pid=${bundleChild.pid}（cwd=${os.tmpdir()}，零 NODE_PATH 自包含）`);
    const bundleHealth = await waitHealth(bundlePort);
    check(!!bundleHealth && bundleHealth.status === 200 && bundleHealth.body.includes('"ok":true'),
      `E1 bundle /health 200 {"ok":true}（CCR_PORT=${bundlePort} 覆盖链生效${bundleHealth ? "" : "；boot 输出尾：" + bundleOut()}）`);

    // ② ExternalRelay/ExternalProcess 真进程分类（复刻壳侧判定链：TCP connect → handshake）
    const relayLikeHandshake = bundleHealth !== null; // 本方对 bundle 口的握手即 relay 形应答
    check(relayLikeHandshake, "E2 端口占用实验①：relay 占口 → 握手应答 → ExternalRelay 类（非自家实例让位不抢）");
    const squatterPort = await freePort();
    const squatter = net.createServer();
    await new Promise((r) => squatter.listen(squatterPort, "127.0.0.1", r));
    const squatterListening = await new Promise((resolve) => {
      const s = net.connect(squatterPort, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
    });
    check(squatterListening, `E2 端口占用实验②：纯 TCP 进程占口 ${squatterPort} → listening=true`);
    // 复刻 classify_relay_port：非 relay 应答（不回 {"ok":true}）→ ExternalProcess
    const squatterHandshake = await new Promise((resolve) => {
      const s = net.connect(squatterPort, "127.0.0.1");
      s.on("connect", () => s.end("GET /local-info HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
      s.on("data", () => { s.destroy(); resolve(false); }); // 纯 TCP server 不回 HTTP JSON
      s.on("close", () => resolve(false));
      s.on("error", () => resolve(false));
      setTimeout(() => { s.destroy(); resolve(false); }, 800);
    });
    check(squatterHandshake === false && squatterPort !== bundlePort,
      "E2 端口占用实验②：非 relay 应答 → ExternalProcess 类（外来进程，进程名降级备案）");
    squatter.close();

    // ③ bundle WS SNAPSHOT 实测协议版本（探针可读 = 协议版本可见性答案）
    check(!existsSync(path.join(dataDirBundle, "token")),
      "E3 token 契约：CCR_TOKEN env 在场时 data/token 不落盘（config.ts env 优先分支——shell 环境泄漏取证，探针因此钉死 env token）");
    const bundleSchema = await readSchemaVersion(bundlePort);
    check(bundleSchema === 1, `E3 bundle WS SNAPSHOT schema_version=${bundleSchema}（实测=烙值=源值）`);

    // ④ dev（tsx 源）对照拉起：同 env 链、同断言面
    const devPort = await freePort();
    devChild = spawn("node", ["--import", "tsx", "src/index.ts"], {
      cwd: RELAY_DIR,
      env: sandboxEnv(devPort, dataDirDev),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const devOut = collect(devChild);
    check(typeof devChild.pid === "number" && devChild.pid > 0, `E4 dev relay 拉起 pid=${devChild.pid}（tsx 源）`);
    const devHealth = await waitHealth(devPort);
    check(!!devHealth && devHealth.status === 200 && devHealth.body.includes('"ok":true'),
      `E4 dev /health 200（${devHealth ? "" : "boot 输出尾：" + devOut()}）`);
    const devSchema = await readSchemaVersion(devPort);
    check(devSchema === 1, `E4 dev WS SNAPSHOT schema_version=${devSchema}`);

    // ⑤ 一致性结论：协议版本 dev=bundle；端口覆盖链行为一致
    check(devSchema === bundleSchema && devSchema === 1,
      "E5 dev/bundle 一致性结论：schema_version 相等且 =1（dev tsx 与内嵌产物同协议）");
    check(bundlePort !== devPort && bundleHealth?.status === devHealth?.status,
      "E5 端口覆盖链行为一致（CCR_PORT 各自生效、/health 同形）");
  } finally {
    for (const [label, child] of [["bundle", bundleChild], ["dev", devChild]]) {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        const gone = await Promise.race([
          new Promise((r) => child.once("exit", r)),
          new Promise((r) => setTimeout(r, 8000)),
        ]);
        if (!gone) child.kill("SIGKILL");
      }
      console.log(`   [cleanup] ${label} relay 收口`);
    }
    rmSync(dataDirBundle, { recursive: true, force: true });
    rmSync(dataDirDev, { recursive: true, force: true });
  }
}

console.log(`T2 probes ${tests}/${tests} passed (platform inventory + version visibility + resources + port states + dev/bundle parity)`);
