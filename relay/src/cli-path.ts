// 定位 Claude CLI 可执行文件（SDK query 的 pathToClaudeCodeExecutable）。
// SDK 默认在其包目录内 require.resolve 平台原生二进制（@anthropic-ai/claude-code-<plat>-<arch>），
// relay 打成单文件 bundle 后目标机器上没有 node_modules，必然抛
// "Native CLI binary for <plat>-<arch> not found"（Windows exe 新建会话首报，2026-09-16）。
// 解析顺序：CC_DECK_CLAUDE_PATH → 包内平台包（dev 模式下等价 SDK 默认行为）→ PATH → 常见安装位置。
// 命中 .cmd/.bat 时换同目录 npm 包的 cli.js——SDK 对非 .js 路径直接 spawn，Windows 上
// Node 的 shell 校验会拒 .cmd；.js 结尾路径 SDK 自动用 node 拉起（sdk.mjs MIe()）。
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";

let cached: string | null | undefined;

function usable(p: string): boolean {
  if (!p || !existsSync(p)) return false;
  if (process.platform === "win32") return true; // Windows 下 X_OK 恒过，exists 即可
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// SDK 同款平台包解析：dev（tsx 直跑/包内 bundle 落在 node_modules 旁）命中即返回；
// 单文件 bundle 部署到用户机器上时 resolve 抛错 → 静默走后续兜底
function fromPlatformPackage(): string | null {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const pkgs = [`@anthropic-ai/claude-code-${process.platform}-${process.arch}`];
  if (process.platform === "linux") {
    // musl 变体优先（SDK kB() 同款顺序）
    pkgs.unshift(`@anthropic-ai/claude-code-linux-${process.arch}-musl`);
  }
  for (const pkg of pkgs) {
    try {
      const p = createRequire(import.meta.url).resolve(`${pkg}/${exe}`);
      if (usable(p)) return p;
    } catch {
      // 包不存在：bundle 部署形态，继续
    }
  }
  return null;
}

function fromPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "win32") {
    // .exe 优先（原生安装器），.cmd/.bat 殿后（需换 cli.js）
    for (const dir of dirs) {
      for (const ext of [".exe", ".cmd", ".bat"]) {
        const p = join(dir, name + ext);
        if (usable(p)) return p;
      }
    }
  } else {
    for (const dir of dirs) {
      const p = join(dir, name);
      if (usable(p)) return p;
    }
  }
  return null;
}

// %APPDATA%\npm\claude.cmd → %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js
// #167：固定相对布局找不到时，解析 npm shim 文本提取真实目标（pnpm/自定义 prefix/
// 新版包布局下 node_modules 不在 .cmd 旁）：shim 里是 node "%~dp0\…\cli.js" %* 形态，
// %~dp0 = .cmd 所在目录。解析失败返回 null（由调用方落回原路径，spawn 层再兜底）。
function cmdToFallbackJs(p: string): string | null {
  const direct = join(dirname(p), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (existsSync(direct)) return direct;
  try {
    const txt = readFileSync(p, "utf8");
    // 提取 "%~dp0\<相对路径>.js"（含无 %~dp0 前缀的绝对/相对写法，取 .js 结尾目标）
    const m = txt.match(/(?:%~dp0\\?"|")(%~dp0\\)?([^"\r\n]+\.js)"/i);
    if (m) {
      const rel = m[2].replace(/\\+/g, "\\");
      const cand = rel.match(/^[a-zA-Z]:[\\/]/) ? rel : join(dirname(p), rel);
      if (existsSync(cand)) return cand;
    }
  } catch {
    // 读不出（编码/权限）：交由 spawn 层兜底
  }
  return null;
}

function knownLocations(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      join(home, ".local", "bin", "claude.exe"), // native 安装器默认位置
      join(appdata, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    ];
  }
  return [
    join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
}

// 结果进程内缓存：PATH/安装位置在运行期不变，且每次新建会话都调（构造器同步路径）
export function resolveClaudeCliPath(): string | null {
  if (cached !== undefined) return cached;
  const candidates: (string | null)[] = [];
  const env = process.env.CC_DECK_CLAUDE_PATH;
  if (env) candidates.push(env);
  candidates.push(fromPlatformPackage());
  const onPath = fromPath("claude");
  if (onPath && /\.(cmd|bat)$/i.test(onPath)) candidates.push(cmdToFallbackJs(onPath) ?? onPath);
  else candidates.push(onPath);
  candidates.push(...knownLocations());
  for (const c of candidates) {
    if (c && usable(c)) {
      cached = c;
      return c;
    }
  }
  cached = null;
  return null;
}
