// 临时排查：RangeError in PromiseRejectCallback 最小复现
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED:", e);
});
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { Bridge } from "../src/bridge.js";

const DATA = fileURLToPath(new URL("../data/debug-rangeerror/", import.meta.url));
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_LEADER = "1";
process.env.CCR_DEAD_SWEEP = "0";
process.env.CCR_NO_TERM_LINE = "1";
const FAKE = join(DATA, "fake.mjs");
writeFileSync(FAKE, 'process.exit(1);\n');
process.env.CCR_INJECT_CMD = FAKE;
process.env.CCR_DATA_DIR = DATA;
process.env.CCR_PROJECTS_ROOT = join(DATA, "projects");

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const bridge = new Bridge(bus, mgr, { gateTools: new Set(["Bash"]), hasClients: () => false, dataDir: DATA });
const id = "ext-dbg-1";
const s = mgr.ensureExternal(id, "/tmp/dbg", "dbg", "dbg-1");
mgr.setExternalCliPid(id, process.pid);
s.status = "DONE";
const r = bridge.extInput(id, "FORCE_FAIL hello");
console.log("extInput:", r);
await wait(3000);
console.log("queue file:", (() => { try { return require("node:fs").readFileSync(join(DATA, "ext-input-queue.json"), "utf-8"); } catch (e) { return String(e); } })());
console.log("pending:", JSON.stringify(s.pending_inputs));
process.exit(0);
