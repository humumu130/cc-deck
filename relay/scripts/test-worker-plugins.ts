// W-KWP2 件一（B 路 B1）—— worker 插件通路测试：plugin-config 第九键 workerPlugins
// 总闸 + listWorkerPluginPaths 目录清单（目录即声明）+ toSdkPlugins 映射纯函数 +
// session-manager newAgent 单咽喉接线（employee 守卫/引擎分叉守卫/总闸关空清单）。
// 隔离口径：CCR_CONFIG_FILE/CCR_WORKER_PLUGINS_DIR 双钉（CCR_CONFIG_FILE 沙盒范式），
// 绝不触生产 ~/.cc-deck/config.json 与 ~/.cc-deck/worker-plugins。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readPluginConfig, pluginConfigPath, listWorkerPluginPaths, workerPluginsDir, PLUGIN_CFG_KEYS } from "../src/plugin-config.js";
import { toSdkPlugins } from "../src/agent-adapter.js";
import { SessionManager } from "../src/session-manager.js";
import { EventBus } from "../src/event-bus.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }
const mkDir = (tag: string) => mkdtempSync(join(tmpdir(), `ccr-wplugins-${tag}-`));

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CCR_CONFIG_FILE", "CCR_WORKER_PLUGINS_DIR"] as const;
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const dirs: string[] = [];

// ---------- S1 第九键形状 + listWorkerPluginPaths ----------
section("\nS1 workerPlugins 键 + 目录清单");
{
  const CFG = mkDir("s1-cfg");
  const PLG = mkDir("s1-plg");
  dirs.push(CFG, PLG);
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  process.env.CCR_WORKER_PLUGINS_DIR = PLG;
  writeFileSync(pluginConfigPath(), JSON.stringify({}) + "\n");
  // ① 缺省：config 无键 → 总闸 false（本键拍板红线「默认关」，与 #107 默认开先例相反是有意设计）
  assert(readPluginConfig().workerPlugins === false, "缺省总闸关（权限面扩大键不走 #107 默认开先例）");
  assert(listWorkerPluginPaths().length === 0, "总闸缺省关 → 清单空");
  // ② 总闸显式关
  writeFileSync(pluginConfigPath(), JSON.stringify({ workerPlugins: false }) + "\n");
  assert(readPluginConfig().workerPlugins === false && listWorkerPluginPaths().length === 0, "显式 false → 清单空（目录有插件也不注入）");
  // ③ 总闸开 + 目录不存在 → 空清单不炸
  writeFileSync(pluginConfigPath(), JSON.stringify({ workerPlugins: true }) + "\n");
  const missing = join(mkDir("s1-tmp"), "not-exist");
  process.env.CCR_WORKER_PLUGINS_DIR = missing;
  dirs.push(missing);
  assert(Array.isArray(listWorkerPluginPaths()) && listWorkerPluginPaths().length === 0, "目录不存在 → []（IO 异常吞为空，不炸会话创建）");
  process.env.CCR_WORKER_PLUGINS_DIR = PLG;
  // ④ 总闸开 + 目录空
  assert(listWorkerPluginPaths().length === 0, "总闸开+目录空 → []");
  // ⑤ 目录即声明：子目录=插件，散文件忽略，字典序稳定
  const plugA = join(PLG, "alpha-plugin");
  const plugB = join(PLG, "beta-plugin");
  mkdirSync(plugA, { recursive: true });
  mkdirSync(join(plugB, "skills"), { recursive: true }); // 嵌套子目录的插件也算一个（顶层目录即清单）
  writeFileSync(join(PLG, ".DS_Store"), "junk");
  writeFileSync(join(PLG, "README.md"), "not a plugin");
  const paths = listWorkerPluginPaths();
  assert(paths.length === 2, `只收目录形态（散文件忽略）：${paths.length} 条`);
  assert(paths[0] === plugA && paths[1] === plugB, "清单按名字典序稳定（同参重建确定性）");
  assert(paths.every((p) => p.startsWith(PLG)), "路径为绝对路径（目录名 join）");
  // ⑥ 键表含第九键
  assert(PLUGIN_CFG_KEYS.includes("workerPlugins"), "PLUGIN_CFG_KEYS 含第九键（SNAPSHOT 同源携带）");
  // ⑦ workerPluginsDir 缺省与 env 覆盖（delete：process.env 赋 undefined 会 coerce 成 "undefined" 字符串）
  delete process.env.CCR_WORKER_PLUGINS_DIR;
  assert(workerPluginsDir().endsWith(join(".cc-deck", "worker-plugins")), "缺省目录 ~/.cc-deck/worker-plugins");
  process.env.CCR_WORKER_PLUGINS_DIR = PLG;
  assert(workerPluginsDir() === PLG, "CCR_WORKER_PLUGINS_DIR 沙盒缝生效");
}

// ---------- S2 toSdkPlugins 映射纯函数 ----------
section("\nS2 toSdkPlugins 映射");
{
  assert(toSdkPlugins([]).length === 0, "空数组 → 空");
  const out = toSdkPlugins(["/a/plug1", "/b/plug2"]);
  assert(out.length === 2 && out[0]!.path === "/a/plug1" && out[1]!.path === "/b/plug2", "路径保序透传");
  assert(out.every((p) => p.type === "local"), "type 恒 local（SDK 目前唯一支持形态）");
  assert(out.every((p) => p.skipMcpDiscovery === true), "skipMcpDiscovery 恒 true（插件 MCP 面不静默扩大）");
}

// ---------- S3 newAgent 单咽喉接线（employee 守卫 + 引擎分叉守卫） ----------
section("\nS3 newAgent 接线");
{
  const DATA = mkDir("s3-data");
  const CFG = mkDir("s3-cfg");
  const PLG = mkDir("s3-plg");
  const plug = join(PLG, "hello-plugin");
  mkdirSync(plug, { recursive: true });
  dirs.push(DATA, CFG, PLG);
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  process.env.CCR_WORKER_PLUGINS_DIR = PLG;
  const cfg: RelayConfig = {
    port: 8798, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  const captured: Record<string, unknown>[] = [];
  mgr.setAgentFactory((_cwd: string, _model: string, _cb: AgentCallbacks, _prompt: string | undefined, opts?: Record<string, unknown>): AgentLike => {
    captured.push(opts ?? {});
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; }, setPermissionMode: async () => {},
    };
    return a;
  });
  // newAgent 是 private：测试经结构化断言直调（单咽喉纯逻辑聚焦，不经完整派单链）
  const callNewAgent = (opts?: Record<string, unknown>): AgentLike =>
    (mgr as unknown as { newAgent: (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, o?: Record<string, unknown>) => AgentLike })
      .newAgent("/tmp", "test-model", {} as AgentCallbacks, undefined, opts);
  const cb = {} as AgentCallbacks;
  // ① 雇员 + 总闸开 → workerPlugins 清单注入
  writeFileSync(pluginConfigPath(), JSON.stringify({ workerPlugins: true }) + "\n");
  captured.length = 0;
  callNewAgent({ employee: true, configHome: "/tmp/home" });
  const o1 = captured[0] as { workerPlugins?: string[] } | undefined;
  assert(Array.isArray(o1?.workerPlugins) && o1!.workerPlugins!.length === 1 && o1!.workerPlugins![0] === plug, "雇员+总闸开 → opts.workerPlugins=目录清单");
  assert(!("employee" in (captured[0] as object)), "employee 标记不透传 agent 层（adapter 不消费）");
  // ② 雇员 + 总闸关 → 空清单（AgentSession 对空数组不传 plugins = 现状）
  writeFileSync(pluginConfigPath(), JSON.stringify({ workerPlugins: false }) + "\n");
  captured.length = 0;
  callNewAgent({ employee: true });
  const o2 = captured[0] as { workerPlugins?: string[] } | undefined;
  assert(Array.isArray(o2?.workerPlugins) && o2!.workerPlugins!.length === 0, "总闸关 → 空清单（不传 plugins=维持现状）");
  // ③ 非雇员 → 键不存在（用户自建会话零波及）
  writeFileSync(pluginConfigPath(), JSON.stringify({ workerPlugins: true }) + "\n");
  captured.length = 0;
  callNewAgent({ configHome: "/tmp/home" });
  assert(!("workerPlugins" in (captured[0] as object)), "非雇员会话无 workerPlugins 键（通路不作用）");
  // ④ codex 引擎 → 键不存在（引擎分叉在 claude 分支之前 return，构造器不认）
  captured.length = 0;
  callNewAgent({ employee: true, engine: "codex" });
  assert(!("workerPlugins" in (captured[0] as object)), "codex 引擎无 workerPlugins 键（非 Claude 引擎零波及）");
  // ⑤ 缺省 opts（无 employee 无引擎）→ 现状路径零变化
  captured.length = 0;
  callNewAgent(undefined);
  assert(!("workerPlugins" in (captured[0] as object)), "缺省调用形状不变（标题生成等非会话级用法零波及）");
}

// ---------- 收尾 ----------
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* tmp 清理尽力而为 */ } }
for (const k of ENV_KEYS) {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
}
console.log(`\nworker-plugins: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
