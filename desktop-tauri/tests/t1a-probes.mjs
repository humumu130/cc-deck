#!/usr/bin/env node
// #018-T1a Tauri spawn/资源存在性源码级探针（无 cargo 依赖，node 直跑）：
//   node desktop-tauri/tests/t1a-probes.mjs
//
// 静态面：main.rs spawn_embedded_relay 结构锚点（node 解析/资源路径/端口 env 注入/
//   spawn 抛错不炸 boot #24 先例/Windows CREATE_NO_WINDOW #501 壳层差异）+ 端口链
//   （CCR_DESKTOP_RELAY_PORT→8788(M2)/8787(生产)）与 relay/src/config.ts 默认值
//   一致性（无漂移、无新增端口）+ 资源存在性检查逻辑在位（ResourceState 三态探针）。
// 动态面：dev relay 真拉起——mkdtemp 数据目录 + 随机高位端口（绝不触生产 8787/8788
//   与 ~/.cc-deck*：CCR_DATA_DIR/CCR_ORG_DIR/CCR_ARTIFACTS_DIR 全指沙箱），验证
//   CCR_PORT 环境覆盖链生效、拉起/健康检查/退出收口三段。
// 备案：Rust 侧 cargo test（mod t1a_tests / tests/t1a-probe.sh）与 resources/ 生成物
//   在场性归 T2/装机批——本探针只断言「检查逻辑在位」（源码锚点），不断言生成物
//   「文件在场」（P1 前文件可能缺，探在场会假红）。本机无 cargo，只做源码级静态
//   探针，真构建/装机验证留 T2（回单备案）。

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAURI_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TAURI_ROOT, "..");
const MAIN_RS = path.join(TAURI_ROOT, "src-tauri", "src", "main.rs");
const CONFIG_TS = path.join(REPO_ROOT, "relay", "src", "config.ts");
const RELAY_DIR = path.join(REPO_ROOT, "relay");

let tests = 0;
const check = (condition, msg = "assertion failed") => {
  tests += 1;
  if (!condition) throw new Error(`#${tests} ${msg}`);
};

const mainRs = readFileSync(MAIN_RS, "utf-8");
const configTs = readFileSync(CONFIG_TS, "utf-8");

// ---------- 静态面：spawn 结构锚点（018 :405 / :501） ----------
{
  check(/fn spawn_embedded_relay\(/.test(mainRs), "spawn_embedded_relay 函数定义在位");
  check(/fn relay_spawn_env\(/.test(mainRs) && mainRs.includes('"CCR_PORT".into()'),
    "spawn env 注入 CCR_PORT（端口传递给内嵌 relay）");
  check(mainRs.includes('"CCR_DATA_DIR".into()'), "spawn env 注入 CCR_DATA_DIR（数据目录隔离）");
  check(/fn apply_relay_spawn_env\(/.test(mainRs) && mainRs.includes('env_remove("NODE_OPTIONS")'),
    "apply_relay_spawn_env 清 NODE_OPTIONS 后设 env（环境卫生）");
  check(/fn node_path\(/.test(mainRs) && mainRs.includes("未检测到 Node.js 运行时"),
    "node 可执行解析在位 + 缺失时明确话术（非静默）");
  check(/match spawn_relay\(/.test(mainRs) && /Err\(e\) => Err\(format!\("relay 启动失败（node 不在 PATH？）：\{e\}"\)\)/.test(mainRs),
    "spawn 抛错 → Err 字符串返回不炸 boot（#24 先例：Err 分支非 panic/unwrap）");
  check(mainRs.includes("#66 respawn failed"),
    "监督线程 respawn 同样吞 Err 只记日志（:545 壳层差异只测 relay 契约的前提面）");
  check(/if EMBEDDED_RELAY\.lock\(\)\.unwrap\(\)\.is_some\(\) \{\s*\n\s*return Ok\(\(\)\);/.test(mainRs),
    "已运行 guard：幂等不双拉（EMBEDDED_RELAY 既有子进程直接 Ok）");
  // Windows 分支（:501 壳层差异点）：CREATE_NO_WINDOW 防 node 子进程闪 cmd 窗
  const winCfgCount = (mainRs.match(/#\[cfg\(target_os = "windows"\)\]/g) ?? []).length;
  check(winCfgCount >= 2, `Windows cfg 分支在位（spawn_relay + node_path；got ${winCfgCount}）`);
  check(/creation_flags\(0x0800_0000\)/.test(mainRs) && mainRs.includes("CREATE_NO_WINDOW"),
    "CREATE_NO_WINDOW creation_flags 在位（Windows 专属防闪窗）");
  check(mainRs.includes('#[cfg(not(target_os = "windows"))]') && /fn spawn_relay\(/.test(mainRs),
    "非 Windows spawn_relay 分流分支在位（无 creation_flags）");
}

// ---------- 静态面：端口约定（018 :22 生产 8787 / 桌面 M2 变体 8788 / 不新增） ----------
{
  check(/const PRODUCTION_RELAY_PORT: u16 = 8787;/.test(mainRs), "生产端口常量 8787 在位");
  check(/const M2_RELAY_PORT: u16 = 8788;/.test(mainRs), "M2 变体端口常量 8788 在位");
  check(/std::env::var\("CCR_DESKTOP_RELAY_PORT"\)/.test(mainRs),
    "CCR_DESKTOP_RELAY_PORT 测试通道覆盖在位");
  check(/\.unwrap_or\(default_relay_port\(M2_BUILD\)\)/.test(mainRs) && /fn default_relay_port\(m2: bool\)/.test(mainRs),
    "端口回落链：env 缺省 → M2_BUILD 选 8788/8787");
  const portLiterals = mainRs.match(/\b87\d{2}\b/g) ?? [];
  check(portLiterals.length > 0 && portLiterals.every((p) => p === "8787" || p === "8788"),
    `main.rs 端口字面量无漂移无新增（全部 ∈ {8787,8788}；got ${[...new Set(portLiterals)].join(",") || "无"}）`);
  check(/process\.env\.CCR_PORT \?\? 8787/.test(configTs),
    "config.ts 端口默认 8787 与 main.rs 生产常量一致（CCR_PORT 覆盖链对齐）");
  check(/process\.env\.CCR_DATA_DIR \?\?/.test(configTs),
    "config.ts 数据目录 CCR_DATA_DIR 覆盖与 main.rs 注入对齐");
}

// ---------- 静态面：资源路径解析 + 存在性检查逻辑在位（生成物在场性归 T2） ----------
{
  check(/fn embedded_relay_resources\(/.test(mainRs) && /\.join\("resources"\)\.join\("relay\.mjs"\)/.test(mainRs),
    "resource_dir → resources/relay.mjs 路径拼装在位");
  check(/fn probe_resource_path\(/.test(mainRs) && /ResourceState::InvalidPath/.test(mainRs)
    && /ResourceState::Missing/.test(mainRs) && /fn resource_error\(/.test(mainRs),
    "存在性检查三态探针在位（absolute→exists→is_file + 差异化错误话术）——任务3：main.rs 已有等价逻辑，无需新增");
  check(/if resource_probe\.script != ResourceState::Present \{/.test(mainRs)
    && /if resource_probe\.inject_cs != ResourceState::Present \{/.test(mainRs),
    "spawn 前置资源闸：relay.mjs/inject.cs 非 Present 即拒启（缺文件不半启动）");
  check(/mod t1a_tests \{/.test(mainRs),
    "Rust 侧 #[cfg(test)] t1a_tests 在位（fixture 探针；cargo 执行归 T2/装机批）");
}

// ---------- 动态面：dev relay 真拉起（mkdtemp + 随机高位端口，三段收口） ----------
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

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cc-t1a-relay-"));
  let child = null;
  try {
    const port = await freePort();
    check(port !== 8787 && port !== 8788 && port > 1024,
      `随机高位端口取证（${port}，非生产 8787/非 M2 8788）`);
    // 沙箱全量：数据/组织/artifacts 全指 mkdtemp——红线：绝不触 ~/.cc-deck*
    child = spawn("node", ["--import", "tsx", "src/index.ts"], {
      cwd: RELAY_DIR,
      env: {
        ...process.env,
        CCR_PORT: String(port),
        CCR_DATA_DIR: dataDir,
        CCR_ORG_DIR: path.join(dataDir, "org"),
        CCR_ARTIFACTS_DIR: path.join(dataDir, "artifacts"),
        CCR_NO_TITLE_GEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => { out = (out + String(c)).slice(-4000); });
    child.stderr.on("data", (c) => { out = (out + String(c)).slice(-4000); });
    check(typeof child.pid === "number" && child.pid > 0, `① 拉起：dev relay 子进程 pid=${child.pid}`);

    // ② 健康检查：CCR_PORT 覆盖链生效——随机口应答，等价断言「未落 8787/8788 默认」
    let health = null;
    const deadline = Date.now() + 20_000; // 仅作轮询死线，无两取时点比对
    while (Date.now() < deadline) {
      health = await getHealth(port);
      if (health) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    check(!!health && health.status === 200 && health.body.includes('"ok":true'),
      `② 健康检查：GET /health → 200 {"ok":true}（env CCR_PORT=${port} 覆盖链生效${health ? "" : "；20s 未应答，boot 输出尾：" + out.slice(-300)}）`);
    check(port !== 8787 && port !== 8788, "② 端口覆盖：应答口即注入口（非 8787/8788 默认口）");

    // ③ 退出收口：SIGTERM → 进程退出 + 端口释放
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    const exit = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r(null), 10_000)),
    ]);
    check(!!exit, `③ 退出收口：SIGTERM 后 10s 内进程退出（code=${exit?.code} signal=${exit?.signal}）`);
    child = null; // 已退出，防 finally 重复 kill
    await new Promise((r) => setTimeout(r, 200));
    const afterKill = await getHealth(port);
    check(!afterKill, "③ 端口释放：退出后 /health 不再应答");
  } finally {
    // exitCode===null = 进程尚未退出（含 SIGTERM 已发但未退的超时路）——兜底 SIGKILL
    // 防孤儿 relay 占口；已退出则 exitCode 非 null，跳过
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log(`T1a probes ${tests}/${tests} passed (static anchors + dynamic dev relay)`);
