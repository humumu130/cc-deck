// @ts-expect-error The direct test runner loads TypeScript through tsx.
import { hasActivityCapability, normalizeActivityCapabilities, normalizeSnapshotPayload, parseSessionActivityPayload, reduceSessionActivity } from "../src/protocol.ts";
import type { SessionState } from "../src/protocol.ts";

const assert: (condition: unknown, message?: string) => void = (condition, message = "assertion failed") => {
  if (!condition) throw new Error(message);
};

const baseSession = (): SessionState => ({
  session_id: "s1",
  relay_session_id: "relay-s1",
  cwd: "/tmp/project",
  initial_prompt: "task",
  title: "task",
  model: "codex",
  status: "WORKING",
  action_summary: "editing",
  started_at: 100,
  updated_at: 120,
  stats: { files_changed: 2, lines_added: 5, lines_deleted: 1 },
});

const activity = (seq_local: number, text: string, capabilities?: unknown) => ({
  session_id: "s1",
  state: "WORKING",
  activity_kind: "tool_use",
  text,
  tool: "Bash",
  observed_at: 200 + seq_local,
  occurred_at: 190 + seq_local,
  capabilities,
  seq_local,
});

let tests = 0;
const check = (condition: unknown): void => {
  tests += 1;
  assert(condition);
};

const parsed = parseSessionActivityPayload(activity(1, "first", { native_status: true }));
check(parsed?.seq_local === 1);
check(parsed?.capabilities.native_status === true);
check(parsed?.capabilities.operation_summary === false);
check(parseSessionActivityPayload({ ...activity(1, "bad"), seq_local: -1 }) === null);

const sessions = new Map([["s1", baseSession()]]);
const activitySeq = new Map<string, number>();
const timelines = new Map([["s1", [{ ts: 150, kind: "system" as const, text: "history" }]]]);
check(reduceSessionActivity(sessions, activitySeq, activity(2, "new", {
  native_status: true,
  operation_summary: true,
  native_elapsed: false,
  approval: false,
})));
const updated = sessions.get("s1")!;
check(updated.activity?.activity?.text === "new");
check(updated.stats.files_changed === 2);
check(updated.updated_at === 120);
check(timelines.get("s1")?.length === 1);
check(hasActivityCapability(updated, "native_status"));
check(!hasActivityCapability(updated, "native_elapsed"));
check(!reduceSessionActivity(sessions, activitySeq, activity(1, "stale")));
check(sessions.get("s1")?.activity?.activity?.text === "new");
check(!reduceSessionActivity(sessions, activitySeq, activity(2, "duplicate")));

const restored = normalizeSnapshotPayload({
  schema_version: 1,
  deliverables: true,
  source_capabilities: { activity: true, notifications: true, commands: ["COMMAND_MESSAGE"] },
  notifications: [{ key: "n1", title: "notice" }],
  sessions: [{
    ...baseSession(),
    activity: {
      state: "WORKING",
      activity: { kind: "assistant_text", text: "restored", observed_at: 300 },
      capabilities: { native_status: true, operation_summary: false, native_elapsed: true, approval: false },
      updated_at: 300,
    },
  }],
});
check(restored.schemaVersion === 1);
check(restored.deliverables);
check(restored.notifications?.length === 1);
check(restored.notificationsLegacy === false);
check(restored.sessions[0].activity?.activity?.text === "restored");
check(restored.sessions[0].activity_capabilities?.native_elapsed === true);
check(restored.sourceCapabilities?.activity === true);
check(restored.sourceCapabilities?.commands?.[0] === "COMMAND_MESSAGE");

const legacy = normalizeSnapshotPayload({ sessions: [{ ...baseSession() }] });
check(legacy.notifications === null);
check(legacy.notificationsLegacy);
check(legacy.schemaVersion === undefined);
check(!legacy.deliverables);
check(legacy.sessions[0].activity === undefined);

const afterReconnectSeq = new Map<string, number>();
const afterReconnect = new Map([["s1", restored.sessions[0]]]);
afterReconnectSeq.clear();
check(afterReconnect.get("s1")?.activity?.activity?.text === "restored");
check(reduceSessionActivity(afterReconnect, afterReconnectSeq, activity(1, "live again")));
check(afterReconnect.get("s1")?.activity?.activity?.text === "live again");

console.log(`E1 reducer tests ${tests}/${tests} passed`);
