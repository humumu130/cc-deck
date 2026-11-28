// DEV-43 演练 B：PM 候命位断档 → T1 wakeup 谓词链 → 云桥直推（同通道实弹）。
// 背景：org 当前 no-leader、PM 候命席空缺——真杀无对象；以谓词链同构演练替代：
// 规则=「duty 位会话转 ERROR」（PM 死亡的同构观测位），事实注入成立 → fire →
// pushCloudAlertAll 打真生产桥（witness 代收）。直跑：
//   env -u CCR_ORG_DIR npx tsx scripts/drill-wakeup.ts <target-dev>
import { WakeupService, type WakeupFacts } from "../src/wakeup.js";
import { pushCloudAlertAll } from "../src/cloud-push.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2] ?? "";
if (!target) { console.error("用法: drill-wakeup.ts <target-dev>"); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), "drill-wakeup-"));

// 事实源两态：PM 候命位在岗（duty 会话 WORKING）→ 断档（转 ERROR）
let pmAlive = true;
const facts = (): WakeupFacts => ({
  sessions: pmAlive
    ? [{ sessionId: "pm-duty-seat", status: "WORKING", external: true }]
    : [{ sessionId: "pm-duty-seat", status: "ERROR", external: true }],
  boardEntries: [],
  notificationPending: 0,
});

const svc = new WakeupService({
  dataDir: dir,
  facts,
  push: async (title, body, level) => {
    const t = Date.now();
    const r = await pushCloudAlertAll(
      { cloudUrl: "wss://cc.humumu.online/cloud", cloudToken: "ccdeck-public-9f3k2m7v", dataDir: dir },
      title, body, level,
    );
    console.log(`[drill] push fired t=+${Date.now() - t}ms targets=${r.targets.join(",")} results=${JSON.stringify(r.results)}`);
  },
  report: (line) => console.log(`[drill-report] ${line}`),
});

console.log(`[drill] armed at ${new Date().toISOString()} target=${target}`);
process.env.CCR_PUSH_TO = target;
svc.arm({
  predicate: { kind: "session_status", status: "ERROR", sessionId: "pm-duty-seat" },
  title: "⚠️ PM 候命位断档（演练B）",
  body: "duty 会话转 ERROR——值守链失主，需人工恢复（谓词链实弹演练）",
  createdBy: "dev43-drill",
  triggerAfterMs: 0,
});

const t0 = Date.now();
let r = await svc.tick();
console.log(`[drill] tick1 (PM 在岗): fired=${r.fired} elapsed=${Date.now() - t0}ms`);
pmAlive = false;
r = await svc.tick();
console.log(`[drill] tick2 (PM 断档): fired=${r.fired} elapsed=${Date.now() - t0}ms`);
const rules = JSON.parse(readFileSync(join(dir, "wakeup-rules.json"), "utf-8")) as Array<{ state: string; firedReason?: string }>;
console.log(`[drill] rule state=${rules[0].state} firedReason=${rules[0].firedReason}`);
rmSync(dir, { recursive: true, force: true });
process.exit(rules[0].state === "fired" && rules[0].firedReason === "predicate" ? 0 : 1);
