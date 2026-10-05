import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import type { Command, SnapshotPayload } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "cc-deck-b0-parity-"));
const oldDataDir = process.env.CCR_DATA_DIR;
const oldCloudUrl = process.env.CCR_CLOUD_URL;
const oldNoTitle = process.env.CCR_NO_TITLE_GEN;
const oldWatchdog = process.env.CCR_WATCHDOG_DISABLE;
let pass = 0;
let fail = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    pass++;
    console.log(`PASS ${message}`);
  } else {
    fail++;
    console.error(`FAIL ${message}`);
  }
}

function fixture(name: string): string {
  return join(process.cwd(), "tests", "fixtures", name);
}

try {
  process.env.CCR_DATA_DIR = join(root, "data");
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_WATCHDOG_DISABLE = "1";

  const oldSnapshot = JSON.parse(readFileSync(fixture("snapshot-old.json"), "utf8")) as SnapshotPayload;
  const newSnapshot = JSON.parse(readFileSync(fixture("snapshot-new.json"), "utf8")) as SnapshotPayload;
  assert(oldSnapshot.notifications === undefined, "旧快照缺少新字段仍可读取");
  assert(newSnapshot.schema_version === 1 && newSnapshot.notifications?.length === 0, "新快照包含 schema/通知字段");
  assert(newSnapshot.sessions[0]?.activity?.state === "WORKING", "新快照 activity 镜像可读取");

  const parityFiles = [
    "snapshot-parity-lan.json",
    "snapshot-parity-cloud-phone.json",
    "snapshot-parity-wan.json",
  ];
  for (const name of parityFiles) {
    const snapshot = JSON.parse(readFileSync(fixture(name), "utf8")) as SnapshotPayload;
    assert(snapshot.schema_version === 1, `${name} 携带 schema_version=1`);
    assert(Array.isArray(snapshot.models), `${name} 携带 models`);
  }

  const relayTypes = readFileSync(join(process.cwd(), "src", "types.ts"), "utf8");
  const wsSource = readFileSync(join(process.cwd(), "src", "ws-server.ts"), "utf8");
  const cloudSource = readFileSync(join(process.cwd(), "src", "cloud-client.ts"), "utf8");
  assert(relayTypes.includes('"SESSION_ACTIVITY"') && relayTypes.includes('"NOTIFICATIONS_UPDATED"'), "relay EventType 已冻结");
  assert(relayTypes.includes('"COMMAND_ORG_ACTION"') && relayTypes.includes('"COMMAND_ARTIFACT_GROUP_FETCH"'), "relay 新命令类型已冻结");
  assert(/schema_version:\s*SNAPSHOT_SCHEMA_VERSION/.test(wsSource), "LAN 快照装配 schema_version");
  assert(wsSource.includes('error: "unsupported command"'), "LAN 未知命令返回统一错误 ACK");
  assert((cloudSource.match(/schema_version:\s*SNAPSHOT_SCHEMA_VERSION/g) ?? []).length === 2, "cloud phone/WAN 快照装配 schema_version");
  assert(/models:\s*listModels\(mgr\.cfg\.model\)/.test(wsSource), "LAN 快照装配 models");
  assert((cloudSource.match(/models:\s*listModels\(this\.mgr\.cfg\.model\)/g) ?? []).length === 2, "cloud phone/WAN 快照装配 models");

  const unknownEvent = JSON.parse(readFileSync(fixture("event-unknown.json"), "utf8")) as { type?: string };
  let ignored = true;
  switch (unknownEvent.type) {
    case "SESSION_ACTIVITY":
    case "NOTIFICATIONS_UPDATED":
      ignored = false;
      break;
    default:
      break;
  }
  assert(ignored, "旧端对未知 EventType 安全忽略");

  const cfg = loadConfig();
  const manager = new SessionManager(new EventBus(), cfg);
  const unknownCommand = JSON.parse(readFileSync(fixture("command-new-to-old.json"), "utf8")) as Command;
  const ack = manager.handleCommand(unknownCommand, "b0-test");
  assert(ack.command_id === "cmd-old-relay" && ack.ok === false && ack.error === "unsupported command", "未知命令返回统一错误 ACK");
  assert(existsSync(join(root, "data")), "测试数据目录隔离于临时目录");
} finally {
  if (oldDataDir === undefined) delete process.env.CCR_DATA_DIR;
  else process.env.CCR_DATA_DIR = oldDataDir;
  if (oldCloudUrl === undefined) delete process.env.CCR_CLOUD_URL;
  else process.env.CCR_CLOUD_URL = oldCloudUrl;
  if (oldNoTitle === undefined) delete process.env.CCR_NO_TITLE_GEN;
  else process.env.CCR_NO_TITLE_GEN = oldNoTitle;
  if (oldWatchdog === undefined) delete process.env.CCR_WATCHDOG_DISABLE;
  else process.env.CCR_WATCHDOG_DISABLE = oldWatchdog;
  rmSync(root, { recursive: true, force: true });
}

console.log(`B0 snapshot parity: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
