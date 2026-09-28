// #17 第二批 雇员独立家设置（产品层）专项：三层合成（env > settings.json > 默认值）、
// 新装默认开/存量默认关、写读往返、env 锁定拒改、applyEmployeeHome 热切换广播。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // ---------- 非布尔载荷拒收（正确性/回归双报 P3-5）----------
    // 缺键/字符串若一律按 false 落盘 = 开关被静默关掉且广播出去
    assert(readSettingsFile(DATA)?.employeeHome === false, "前置：当前文件为关");
    // 故意传非布尔类型（协议层是 boolean，绕过类型系统模拟裸协议灌包）
    const mkCmd = (payload: unknown) =>
      ({ command_id: `t-set-${Math.random().toString(36).slice(2, 8)}`, type: "COMMAND_SETTINGS_UPDATE", payload, ts: Date.now() }) as unknown as Parameters<typeof mgr.handleCommand>[0];
    const bad1 = mgr.handleCommand(mkCmd({ employee_home: "true" }), "test");
    assert(bad1.ok === false && (bad1.error ?? "").includes("布尔"), `字符串载荷拒收 got=${JSON.stringify(bad1)}`);
    const bad2 = mgr.handleCommand(mkCmd({}), "test");
    assert(bad2.ok === false, "缺键载荷拒收");
    assert(readSettingsFile(DATA)?.employeeHome === false && seen.length === 2, "拒收时文件/广播零变动");
  }

  // ---------- 真实启动序回归锁（P1：新装默认开不得是死码）----------
  // 生产入口序 = loadConfig()（首启写 token/bridge-token）→ resolveEmployeeHome。
  // 修复前 loadConfig 写盘先于判定 → isFreshInstall 恒 false → default 层恒「存量关」
  {
    console.log("启动序（loadConfig 先于合成，P1 回归锁）:");
    const DATA2 = mkdtempSync(join(tmpdir(), "ccr-settings-boot-"));
    process.env.CCR_DATA_DIR = DATA2;
    try {
      const cfg2 = loadConfig(); // 首启：token/bridge-token 落盘
      assert(cfg2.freshInstall === true, "写盘前捕获 freshInstall=true");
      const st = resolveEmployeeHome(DATA2, cfg2.freshInstall);
      assert(st.enabled === true && st.source === "default", `新装首靴 default 层=开 got=${JSON.stringify(st)}`);
      // index.ts 物化（防振荡）：default 决定落 settings.json——此后 default 层的
      // 可变推导（events.ndjson 出现等）不再影响开关
      writeSettingsFile(DATA2, { employeeHome: st.enabled });
      const st2 = resolveEmployeeHome(DATA2); // 运行期调用不带 hint
      assert(st2.enabled === true && st2.source === "file", "物化后走 file 层（不再现算 default）");
      // 二靴：token 已在 → freshInstall=false，但 file 层接管，开关不翻转
      const cfg3 = loadConfig();
      assert(cfg3.freshInstall === false, "二靴 freshInstall=false");
      const st3 = resolveEmployeeHome(DATA2, cfg3.freshInstall);
      assert(st3.enabled === true && st3.source === "file", "物化防振荡（二靴不因存量判定翻关）");
      // 对照组：存量未物化（无 settings.json）→ default 层关
      const DATA3 = mkdtempSync(join(tmpdir(), "ccr-settings-legacy-"));
      process.env.CCR_DATA_DIR = DATA3;
      try {
        const cfg4 = loadConfig();
        writeFileSync(join(DATA3, "events.ndjson"), "\n", "utf-8"); // 有过会话的存量
        const cfg5 = loadConfig();
        assert(cfg5.freshInstall === false, "存量 freshInstall=false");
        assert(resolveEmployeeHome(DATA3, cfg5.freshInstall).enabled === false, "存量未表态 → default 层关（行为不变）");
      } finally {
        process.env.CCR_DATA_DIR = DATA;
        rmSync(DATA3, { recursive: true, force: true });
      }
    } finally {
      process.env.CCR_DATA_DIR = DATA;
      rmSync(DATA2, { recursive: true, force: true });
    }
  }

  // ---------- 损坏 settings.json 容错（边界 P2-1）+ 原子合并保兄弟键 ----------
  {
    console.log("损坏容错与原子写:");
    const DATA4 = mkdtempSync(join(tmpdir(), "ccr-settings-corrupt-"));
    try {
      writeFileSync(join(DATA4, "settings.json"), '{"employeeHome": tru', "utf-8"); // 半写垃圾
      assert(readSettingsFile(DATA4) === null, "损坏文件 → null（不炸，按未配置处理）");
      assert(resolveEmployeeHome(DATA4).enabled === false, "损坏回落 default 层（存量=关，失败方向安全）");
      assert(writeSettingsFile(DATA4, { employeeHome: true }), "覆写修复成功");
      assert(readSettingsFile(DATA4)?.employeeHome === true, "修复后可读");
      // 合并语义：未来兄弟键不被单键覆写抹掉
      writeFileSync(join(DATA4, "settings.json"), JSON.stringify({ employeeHome: true, futureKey: 42 }), "utf-8");
      writeSettingsFile(DATA4, { employeeHome: false });
      const raw = JSON.parse(readFileSync(join(DATA4, "settings.json"), "utf-8")) as { employeeHome: boolean; futureKey?: number };
      assert(raw.employeeHome === false && raw.futureKey === 42, "原子合并保留兄弟键");
      // 非对象根（数组等）拒收
      writeFileSync(join(DATA4, "settings.json"), "[1,2,3]", "utf-8");
      assert(readSettingsFile(DATA4) === null, "数组根 → 按未配置处理");
    } finally {
      rmSync(DATA4, { recursive: true, force: true });
    }
  }
} finally {
  if (prevEnv === undefined) delete process.env.CCR_EMPLOYEE_CONFIG_DIR; else process.env.CCR_EMPLOYEE_CONFIG_DIR = prevEnv;
  if (prevData === undefined) delete process.env.CCR_DATA_DIR; else process.env.CCR_DATA_DIR = prevData;
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\nSETTINGS TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
