// #7 SDK 会话流看门狗的进程树工具：快照（pid/ppid/累计 CPU 时间）、后代求和、杀树。
// 独立纯函数模块（无状态、可注入替身），session-manager 的看门狗采样与恢复都经此。
import { execFile } from "node:child_process";

// ps/wmic 的累计 CPU 时间 → 毫秒。两家格式都收：
//   macOS ps time: "9:13.63"（M:SS.cc）或 "1:02:03.44"（H:MM:SS.cc）
//   Linux ps time: "00:00:01"（HH:MM:SS）或 "1-02:03:04"（DD-HH:MM:SS）
export function parseCpuTimeMs(s: string): number {
  const raw = (s || "").trim();
  if (!raw) return 0;
  let days = 0;
  let body = raw;
  const dm = /^(\d+)-(.+)$/.exec(raw);
  if (dm) {
    days = Number(dm[1]);
    body = dm[2];
  }
  const parts = body.split(":").map((x) => Number(x.replace(/[^0-9.]/g, "")) || 0);
  // 从右往左固定语义：秒(.厘秒) 分 时——段数不足时高位缺省 0
  const sec = parts[parts.length - 1] ?? 0;
  const min = parts[parts.length - 2] ?? 0;
  const hour = parts[parts.length - 3] ?? 0;
  return Math.round((days * 86400 + hour * 3600 + min * 60 + sec) * 1000);
}

export interface ProcSnapshot {
  ppid: number;
  cpuMs: number;
}

// 全系统进程快照：pid -> { ppid, 累计CPU毫秒 }。POSIX 走 ps；Windows 走 PowerShell
// Get-CimInstance（KernelModeTime+UserModeTime 是 100ns 单位）。失败返回空表——
// 调用方拿不到数据时树 CPU 记 0，方向上偏向"判僵死"，由快速/慢速通道的前置
// 时间窗（3/10 分钟无事件）兜底误杀风险。
export async function snapshotTree(): Promise<Map<number, ProcSnapshot>> {
  const out = new Map<number, ProcSnapshot>();
  if (process.platform === "win32") {
    const stdout = await psExec("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $([int64]$_.KernelModeTime + [int64]$_.UserModeTime)\" }",
    ]);
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) out.set(Number(m[1]), { ppid: Number(m[2]), cpuMs: Math.round(Number(m[3]) / 10_000) });
    }
    return out;
  }
  const stdout = await psExec("ps", ["-eo", "pid=,ppid=,time="]);
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), cpuMs: parseCpuTimeMs(m[3]) });
  }
  return out;
}

function psExec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? "" : String(stdout));
      });
    } catch {
      resolve("");
    }
  });
}

// root 及其全部后代 pid（BFS 按 ppid 链追）。快照是全量表，追树 O(n)。
export function descendantsOf(snap: Map<number, ProcSnapshot>, root: number): Set<number> {
  const out = new Set<number>([root]);
  // 反向索引：ppid -> 子 pid 列表
  const children = new Map<number, number[]>();
  for (const [pid, p] of snap) {
    const arr = children.get(p.ppid);
    if (arr) arr.push(pid);
    else children.set(p.ppid, [pid]);
  }
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const kid of children.get(cur) ?? []) {
      if (!out.has(kid)) {
        out.add(kid);
        queue.push(kid);
      }
    }
  }
  return out;
}

// 整树累计 CPU 毫秒（root + 后代）。pid 不在快照（进程已消失/权限不可见）按 0 计。
export function treeCpuMs(snap: Map<number, ProcSnapshot>, root: number): number {
  let total = 0;
  for (const pid of descendantsOf(snap, root)) total += snap.get(pid)?.cpuMs ?? 0;
  return total;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 杀整树：先 SIGTERM（CLI 可优雅收尾、落 transcript），3s 仍活 SIGKILL 补刀。
// 顺序从根往下（先杀父，父自身收尾时可能带走子孙）；Windows 无信号语义直接
// taskkill /T /F。返回 killed（发过信号）/ gone（本来就没了）。
export async function killTree(root: number): Promise<"killed" | "gone"> {
  if (process.platform === "win32") {
    await psExec("taskkill", ["/PID", String(root), "/T", "/F"]);
    return "killed";
  }
  const snap = await snapshotTree();
  const tree = [...descendantsOf(snap, root)];
  if (!alive(root) && tree.every((p) => p !== root && !alive(p))) return "gone";
  for (const pid of tree) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (!tree.some(alive)) return "killed";
  }
  for (const pid of tree) {
    try {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    } catch {}
  }
  return "killed";
}
