// #17 第二批 雇员独立家设置（产品层）专项：三层合成（env > settings.json > 默认值）、
// 新装默认开/存量默认关、写读往返、env 锁定拒改、applyEmployeeHome 热切换广播。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import {
  defaultSettings,
  isFreshInstall,
  readSettingsFile,
  resolveEmployeeHome,
  writeSettingsFile,
} from "../src/settings.js";

let pass = 0, fail = 0;
const assert = (c: boolean, name: string) => {
  if (c) { pass++; console.log(`  ok - ${name}`); } else { fail++; console.error(`FAIL: ${name}`); }
};

const prevEnv = process.env.CCR_EMPLOYEE_CONFIG_DIR;
const prevData = process.env.CCR_DATA_DIR;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;

const DATA = mkdtempSync(join(tmpdir(), "ccr-settings-"));
process.env.CCR_DATA_DIR = DATA;

try {
  // ---------- 新装/存量默认值 ----------
  console.log("默认值策略:");
  assert(isFreshInstall(DATA), "空数据目录 = 新装");
  assert(defaultSettings(DATA).employeeHome === true, "新装默认开（零迁移负担）");
  writeFileSync(join(DATA, "events.ndjson"), "\n", "utf-8");
  assert(!isFreshInstall(DATA), "有事件流 = 存量升级");
  assert(defaultSettings(DATA).employeeHome === false, "存量升级默认关（行为不变）");
  rmSync(join(DATA, "events.ndjson"), { force: true });

  // ---------- 三层合成 ----------
  console.log("三层合成（env > file > default）:");
  {
    const s = resolveEmployeeHome(DATA);
    assert(s.enabled === true && s.source === "default" && s.value === join(DATA, "claude-home"),
      `无文件新装 → default 层开启，auto 已展开 got=${JSON.stringify(s)}`);
    writeSettingsFile(DATA, { employeeHome: false });
    const s2 = resolveEmployeeHome(DATA);
    assert(s2.enabled === false && s2.value === null && s2.source === "file", "文件关 → file 层关闭");
    writeSettingsFile(DATA, { employeeHome: true });
    process.env.CCR_EMPLOYEE_CONFIG_DIR = "/tmp/ccr-emp-override";
    const s3 = resolveEmployeeHome(DATA);
    assert(s3.enabled === true && s3.source === "env" && s3.value === "/tmp/ccr-emp-override",
      "env 显式设置 > 文件（部署覆盖用户面）");
    process.env.CCR_EMPLOYEE_CONFIG_DIR = "relative/bad";
    const s4 = resolveEmployeeHome(DATA);
    assert(s4.enabled === false && s4.source === "env", "env 非法相对路径 → 按关闭但来源仍 env（UI 锁定只读）");
    delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
    assert(readSettingsFile(DATA)?.employeeHome === true, "写读往返");
  }

  // ---------- applyEmployeeHome：热切换 + 广播 + env 锁定 ----------
  console.log("applyEmployeeHome:");
  {
    writeSettingsFile(DATA, { employeeHome: false });
    const cfg = loadConfig();
    cfg.employeeConfigDir = resolveEmployeeHome(DATA).value; // 启动序合成（index.ts 同款）
    assert(cfg.employeeConfigDir === null, "前置：文件关 → cfg 关");
    const mgr = new SessionManager(new EventBus(), cfg);
    const seen: { employee_home: boolean; value: string | null }[] = [];
    const bus = (mgr as unknown as { bus: EventBus }).bus;
    bus.subscribe((e) => {
      if (e.type === "SETTINGS_UPDATED") seen.push(e.payload as { employee_home: boolean; value: string | null });
    });
    const r1 = mgr.applyEmployeeHome(true);
    assert(r1.ok === true && r1.data?.employee_home === true && r1.data.value === join(DATA, "claude-home"),
      `热开 → ok + ack 带最新状态 got=${JSON.stringify(r1)}`);
    assert(cfg.employeeConfigDir === join(DATA, "claude-home"), "cfg 热生效（新会话立即用新家）");
    assert(readSettingsFile(DATA)?.employeeHome === true, "settings.json 落盘");
    assert(seen.length === 1 && seen[0].employee_home === true, "SETTINGS_UPDATED 瞬态广播");
    const r2 = mgr.applyEmployeeHome(false);
    assert(r2.ok === true && cfg.employeeConfigDir === null && seen.length === 2 && seen[1].employee_home === false,
      "热关同理（往返）");
    // env 锁定：拒改（部署面优先，UI 只读）
    process.env.CCR_EMPLOYEE_CONFIG_DIR = "/tmp/ccr-emp-locked";
    const r3 = mgr.applyEmployeeHome(true);
    assert(r3.ok === false && (r3.error ?? "").includes("环境变量"), "env 锁定 → 拒改带可读指引");
    assert(readSettingsFile(DATA)?.employeeHome === false && seen.length === 2, "锁定时文件/广播不动");
    assert(mgr.employeeHomeState().source === "env" && mgr.employeeHomeState().employee_home === true,
      "状态口现算反映 env 锁定（SNAPSHOT settings 数据源）");
    delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
  }
} finally {
  if (prevEnv === undefined) delete process.env.CCR_EMPLOYEE_CONFIG_DIR; else process.env.CCR_EMPLOYEE_CONFIG_DIR = prevEnv;
  if (prevData === undefined) delete process.env.CCR_DATA_DIR; else process.env.CCR_DATA_DIR = prevData;
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\nSETTINGS TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
