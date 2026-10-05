import { mapActivityState, type ActivityTaskSources, type MappedStatusDock } from "./agent-adapter.js";

export const ZCODE_ACTIVITY_CAPABILITIES = {
  native_status: false,
  operation_summary: false,
  native_elapsed: false,
  approval: false,
} as const;

export interface ZCodeActivityOptions {
  now?: number;
  task?: ActivityTaskSources;
}

/** ZCode 未通过隐私/遥测 preflight；保持显式 unsupported，不伪造活动。 */
export function mapZCodeActivity(options: ZCodeActivityOptions = {}): MappedStatusDock {
  return mapActivityState({
    state: "ERROR",
    now: options.now,
    task: options.task,
    capabilities: ZCODE_ACTIVITY_CAPABILITIES,
    unsupported: "ZCode privacy/telemetry preflight 未通过；activity unsupported",
  });
}
