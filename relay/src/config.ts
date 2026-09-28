import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
// 循环 import 安全：settings.ts ← config.ts 只在函数体内互调（parseEmployeeConfigDir
// / isFreshInstall 均运行期取 live binding），无模块初始化期交叉
import { isFreshInstall } from "./settings.js";

// #17 三态解析（纯函数，无副作用——告警由调用方负责）：
// "" / null → null（关闭）；"auto" → dataDir 下 claude-home（resolve 绝对化）；
// 绝对路径 → 原样；相对路径 → null（拒绝，防 cwd 漂移）。
// auto 无需 mkdir：CLI 对不存在的 CLAUDE_CONFIG_DIR（含嵌套缺失父目录）自建并
// 正常运行（边界审查实测 2.1.269）；relay 读取路径对缺失目录 catch/null 失败
// 安全——后人勿「补 mkdir」。
export function parseEmployeeConfigDir(v: string | null | undefined, dataDir: string): string | null {
  const t = (v ?? "").trim();
  if (t === "auto") {
    // resolve 绝对化：CCR_DATA_DIR 允许相对，join 产物若仍是相对串会把「家按
    // cwd 漂移」从显式相对分支重新放进来（审查 P2-1——CLI 子进程 cwd 与
    // relay 读取路径 cwd 不同，读写两头错位）
    return resolve(join(dataDir, "claude-home"));
  }
  return t && isAbsolute(t) ? t : null;
}

export interface RelayConfig {
  port: number;
  token: string;
  tokenGenerated: boolean;   // true = 本次运行随机生成，启动时打印
  defaultCwd: string;
  model: string;
  bridgeToken: string;       // hooks 桥接令牌（data/bridge-token，首启生成后固定）
  dataDir: string;
  cloudUrls: string[];       // 云桥地址列表（CCR_CLOUD_URL 逗号分隔），空 = 云桥禁用
  cloudUrl: string;          // 主桥（首地址）：PAIR_ACK 下发给新配对设备
  cloudToken: string;        // 云桥层连接 token（CCR_CLOUD_TOKEN，所有桥共用）
  // 雇员独立家目录（#17）：null = 关闭（行为与从前一致）；路径 = 启用，relay
  // spawn 的雇员会话（Leader/worker/随手办）CLI 子进程 CLAUDE_CONFIG_DIR 指到
  // 该目录，transcript/任务清单与用户默认家（~/.claude）物理隔离。
  // CCR_EMPLOYEE_CONFIG_DIR 三态：未设置 = 关闭；"auto" = <dataDir>/claude-home；
  // 绝对路径 = 自定义位置。相对路径视为配置错误按关闭处理并告警（防 cwd 漂移
  // 让家跟着启动目录走）
  employeeConfigDir: string | null;
  // #17 第二批审查修正 P1：新装判定预算值——loadConfig 在写 token/bridge-token
  // 之前捕获（首启那两个文件落盘后再判恒为「存量」，「新装默认开」成死码）。
  // index.ts 启动序把它传给 resolveEmployeeHome；可选=测试字面量不必填
  freshInstall?: boolean;
}

export function loadConfig(): RelayConfig {
  const port = Number(process.env.CCR_PORT ?? 8787);
  // 插件 bundle（CC_DECK_PLUGIN 由 esbuild define 注入）数据固定 ~/.cc-deck/data，
  // 与插件升级/卸载解耦；开发模式默认 relay/data
  const dataDir =
    process.env.CCR_DATA_DIR ??
    ((process.env.CC_DECK_PLUGIN as string | undefined)
      ? join(homedir(), ".cc-deck", "data")
      : join(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true });

  // #17 第二批审查修正 P1：新装判定必须先于下方 token/bridge-token 首启落盘——
  // isFreshInstall 把这两个文件当「至少跑过一次」的信号，晚于写盘判恒 false
  const freshInstall = isFreshInstall(dataDir);

  const envToken = process.env.CCR_TOKEN;
  // 插件/daemon 形态没有外部传 token：data/token 持久化（首启生成，重启不变，手机不用重配）
  const tokenFile = join(dataDir, "token");
  let token: string;
  if (envToken && envToken.length >= 8) {
    token = envToken;
  } else if (existsSync(tokenFile)) {
    token = readFileSync(tokenFile, "utf-8").trim();
  } else {
    token = randomUUID().replace(/-/g, "");
    writeFileSync(tokenFile, token, "utf-8");
  }
  // #293 默认工作目录三级来源：CCR_CWD 显式配置 → sticky（上次创建会话的有效目录，
  // data/last-cwd，session-manager 创建成功时写入）→ 用户主目录。守护/插件形态下
  // process.cwd() 常指向安装目录甚至已删除的启动目录，不适合当会话 cwd；sticky 让
  // 手机端残留的无效目录（Windows 时代的 /C: 等）自动落到真实项目目录而非家目录
  //（2026-09-18 三连"卡住"根因收口）；homedir 跨平台始终可用兜底
  let defaultCwd = process.env.CCR_CWD || "";
  if (!defaultCwd) {
    try { defaultCwd = readFileSync(join(dataDir, "last-cwd"), "utf-8").trim(); } catch {}
  }
  if (!defaultCwd) defaultCwd = homedir();
  // spike 结论：必须显式指定 model，否则 CLI 会给默认模型名拼 [1m] 后缀
  const model =
    process.env.CCR_MODEL ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "glm-5.3";

  let bridgeToken = process.env.CCR_BRIDGE_TOKEN ?? "";
  const bridgeTokenPath = join(dataDir, "bridge-token");
  if (!bridgeToken) {
    if (existsSync(bridgeTokenPath)) {
      bridgeToken = readFileSync(bridgeTokenPath, "utf-8").trim();
    } else {
      bridgeToken = randomUUID().replace(/-/g, "");
      writeFileSync(bridgeTokenPath, bridgeToken, "utf-8");
    }
  }

  // 多桥并行：逗号分隔多个地址（如 CF wss + ECS ws），每桥一个 CloudClient 实例；
  // 首地址为主桥（PAIR_ACK 下发给新配对手机的地址）。
  // 开箱即用：未配置时默认连 CC Deck 公共桥（公开 token + 限流防滥用；桥只见 E2E 密文，
  // 设备间按公钥派生 dev id 路由、互不可见）。自建桥后用 CCR_CLOUD_URL/CCR_CLOUD_TOKEN 覆盖；
  // CCR_CLOUD_URL 设为空串可完全禁用云桥
  const DEFAULT_CLOUD_URL = "wss://cc.humumu.online/cloud";
  const DEFAULT_CLOUD_TOKEN = "ccdeck-public-9f3k2m7v";
  const cloudUrls = (process.env.CCR_CLOUD_URL ?? DEFAULT_CLOUD_URL)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cloudToken = process.env.CCR_CLOUD_TOKEN ?? DEFAULT_CLOUD_TOKEN;

  // #17 雇员独立家三态解析（见 RelayConfig.employeeConfigDir 注释；纯函数抽至
  // parseEmployeeConfigDir 供 settings.ts 产品层复用）
  const envRaw = (process.env.CCR_EMPLOYEE_CONFIG_DIR ?? "").trim();
  if (envRaw && !isAbsolute(envRaw) && envRaw !== "auto") {
    // 相对路径不可预测（守护进程 cwd 漂移），拒绝启用而非猜一个位置；
    // "~" 开头不会自动展开，提示用户用 $HOME 展开后的绝对路径
    console.warn(`[config] CCR_EMPLOYEE_CONFIG_DIR 需绝对路径或 "auto"（~ 请展开为 $HOME/...），收到相对路径 "${envRaw}"，雇员独立家保持关闭`);
  }
  const employeeConfigDir = parseEmployeeConfigDir(envRaw, dataDir);

  return {
    port, token, tokenGenerated: !envToken, defaultCwd, model, bridgeToken, dataDir, freshInstall,
    cloudUrls, cloudUrl: cloudUrls[0] ?? "", cloudToken, employeeConfigDir,
  };
}
