import { basename, dirname, normalize, resolve } from "node:path";
import type { ArtifactItem } from "./types.js";

export type ArtifactViewOrigin = "artifacts" | "deliverable" | "session";
// #72A0（P2-3C）："unknown" = 缺 exists 证据（无 scan/登记 boolean 报告），不默认存在
export type ArtifactViewExistence = "exists" | "missing" | "unreachable" | "unknown";

export interface ArtifactViewScanEntry {
  name?: string;
  path?: string;
  normalized_path?: string;
  source_id?: string;
  sourceId?: string;
  size?: number;
  mtime?: number;
  exists?: boolean;
  reachable?: boolean;
  source_reachable?: boolean;
  artifacts_root?: string;
}

export interface ArtifactViewRegistration extends Omit<Partial<ArtifactItem>, "origin"> {
  path?: string;
  normalized_path?: string;
  source_id?: string;
  sourceId?: string;
  session_id?: string;
  sessionId?: string;
  project_gid?: string;
  projectGid?: string;
  project_gids?: string[];
  projectGids?: string[];
  cwd?: string;
  session_cwd?: string;
  delivery_group_key?: string;
  deliveryGroupKey?: string;
  batch_id?: string;
  batchId?: string;
  derived_prefix_group?: string;
  size?: number;
  mtime?: number;
  exists?: boolean;
  reachable?: boolean;
  source_reachable?: boolean;
  sourceReachable?: boolean;
  capabilities?: Record<string, boolean>;
}

export interface ArtifactViewSession {
  session_id?: string;
  sessionId?: string;
  source_id?: string;
  sourceId?: string;
  project_gid?: string;
  projectGid?: string;
  project_gids?: string[];
  projectGids?: string[];
  cwd?: string;
  session_cwd?: string;
  source_reachable?: boolean;
  sourceReachable?: boolean;
  reachable?: boolean;
  artifacts?: readonly ArtifactViewRegistration[];
  deliverables?: readonly ArtifactViewRegistration[];
}

export interface ArtifactViewInput {
  artifacts?: readonly ArtifactViewScanEntry[];
  artifact_scan?: readonly ArtifactViewScanEntry[];
  files?: readonly ArtifactViewScanEntry[];
  artifacts_root?: string;
  sessions?: readonly ArtifactViewSession[];
  registrations?: readonly ArtifactViewRegistration[];
  deliverables?: readonly ArtifactViewRegistration[];
  sources?: Record<string, { reachable?: boolean } | boolean>;
}

export interface ArtifactViewCapabilities {
  open: boolean;
  download: boolean;
  reveal: boolean;
  retry: boolean;
}

export interface ArtifactViewRecord {
  source_id: string;
  normalized_path: string;
  display_name: string;
  origin: ArtifactViewOrigin;
  session_ids: string[];
  project_gids: string[];
  group_key: string;
  exists: boolean;
  existence_state: ArtifactViewExistence;
  availability: ArtifactViewExistence;
  status: ArtifactViewExistence;
  source_reachable: boolean | null;
  size: number | null;
  mtime: number | null;
  capabilities: ArtifactViewCapabilities;
  delivery_group_key: string | null;
  derived_prefix_group: string | null;
  derived_prefix_label: "按文件名前缀推断" | null;
  collapsed: boolean;
  source_label: string;
  needs_refresh: boolean;
}

const UNKNOWN_SOURCE = "unknown";
const UNKNOWN_LABEL = "来源未知/待刷新";

type SourceState = { id: string; known: boolean; reachable?: boolean };
type PathState = { path: string; verifiable: boolean };
type RegistrationContext = {
  sessionId?: string;
  projectGids: string[];
  source: SourceState;
  cwd?: string;
  reachable?: boolean;
};

type Accumulator = {
  key: string;
  source_id: string;
  source_known: boolean;
  normalized_path: string;
  display_name: string;
  origin: ArtifactViewOrigin;
  session_ids: string[];
  project_gids: string[];
  source_reachable?: boolean;
  source_unknown: boolean;
  path_verifiable: boolean;
  unverified: boolean;
  registration_exists?: boolean;
  artifact_exists?: boolean;
  size: number | null;
  mtime: number | null;
  delivery_group_key: string | null;
  derived_prefix_group: string | null;
};

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

// #72A0（P1-1C）：NUL 与 C0 控制字符显式拒绝——裸拼接键的分隔符歧义源头，边界层
// 拒收后走 unknown/unverified 分支（不抛异常）
const C0_CONTROL_RE = /[\u0000-\u001f]/;
function hasControlChars(value: string): boolean {
  return C0_CONTROL_RE.test(value);
}

function normalizedPath(path: string): string {
  return normalize(path).replaceAll("\\", "/").replace(/\/+$/, "") || ".";
}

function pathState(record: { path?: unknown; normalized_path?: unknown; name?: unknown }, cwd?: string, root?: string): PathState {
  const raw = stringValue(record.normalized_path, record.path, record.name);
  if (!raw) return { path: "", verifiable: false };
  // #72A0（P1-1C）：含 NUL/C0 的路径显式拒绝——不可验证，走 unverified 分支不抛异常
  if (hasControlChars(raw)) return { path: "", verifiable: false };
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { path: normalizedPath(resolve(raw)), verifiable: true };
  }
  if (cwd) return { path: normalizedPath(resolve(cwd, raw)), verifiable: true };
  if (root) return { path: normalizedPath(resolve(root, raw)), verifiable: true };
  return { path: normalizedPath(raw), verifiable: false };
}

function sourceState(record: Record<string, unknown>, fallback?: SourceState): SourceState {
  const raw = stringValue(record.source_id, record.sourceId);
  if (raw) {
    // #72A0（P1-1C）：显式携带 NUL/C0 的 source_id 视为非法——落 unknown/unverified
    // 分支（不回落 fallback、不抛异常），防构造键碰撞/跨源错挂归属
    if (hasControlChars(raw)) return { id: UNKNOWN_SOURCE, known: false };
    return { id: raw, known: true };
  }
  if (fallback) return { ...fallback };
  return { id: UNKNOWN_SOURCE, known: false };
}

function booleanValue(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function sourceReachability(record: Record<string, unknown>, context: RegistrationContext, sources: ArtifactViewInput["sources"]): boolean | undefined {
  const explicit = booleanValue(record.source_reachable, record.sourceReachable, record.reachable);
  if (explicit !== undefined) return explicit;
  if (context.reachable !== undefined) return context.reachable;
  const source = sources?.[context.source.id];
  if (typeof source === "boolean") return source;
  return source?.reachable;
}

function projectIds(record: Record<string, unknown>, context: RegistrationContext): string[] {
  const values = [
    ...(Array.isArray(record.project_gids) ? record.project_gids : []),
    ...(Array.isArray(record.projectGids) ? record.projectGids : []),
    record.project_gid,
    record.projectGid,
    ...context.projectGids,
  ];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}

function addUnique(list: string[], values: readonly string[]): void {
  for (const value of values) if (value && !list.includes(value)) list.push(value);
}

function prefixGroup(displayName: string): string | null {
  const match = displayName.match(/^(\d{2,}-)/);
  return match?.[1] ?? null;
}

function explicitDeliveryGroup(record: Record<string, unknown>): string | null {
  return stringValue(record.delivery_group_key, record.deliveryGroupKey, record.batch_id, record.batchId) ?? null;
}

function originFor(kind: ArtifactViewOrigin, current: ArtifactViewOrigin): ArtifactViewOrigin {
  if (kind === "deliverable" || current === "deliverable") return "deliverable";
  if (kind === "artifacts" || current === "artifacts") return "artifacts";
  return "session";
}

function createAccumulator(key: string, source: SourceState, path: PathState, kind: ArtifactViewOrigin, record: Record<string, unknown>): Accumulator {
  const displayName = path.path ? basename(path.path) : stringValue(record.name, record.path) ?? UNKNOWN_LABEL;
  return {
    key,
    source_id: source.id,
    source_known: source.known,
    normalized_path: path.path,
    display_name: displayName,
    origin: kind,
    session_ids: [],
    project_gids: [],
    source_unknown: !source.known,
    path_verifiable: path.verifiable,
    unverified: !source.known || !path.verifiable,
    size: typeof record.size === "number" ? record.size : null,
    mtime: typeof record.mtime === "number" ? record.mtime : typeof record.last_at === "number" ? record.last_at : null,
    delivery_group_key: explicitDeliveryGroup(record),
    derived_prefix_group: prefixGroup(displayName),
  };
}

function addRecord(
  map: Map<string, Accumulator>,
  counter: { value: number },
  kind: ArtifactViewOrigin,
  record: Record<string, unknown>,
  context: RegistrationContext,
  input: ArtifactViewInput,
  root?: string,
): void {
  const path = pathState(record, context.cwd, root);
  const source = sourceState(record, context.source);
  const mergeable = source.known && path.verifiable && path.path.length > 0;
  // #72A0（P1-1C）：merge key 弃用 source/path 裸拼接（\u0000 分隔符歧义可构造碰撞，
  // 如 (source "a", path "/dir\u0000b") 与 (source "a\u0000", path "b") 同键），改 JSON 数组
  // 结构化编码——键空间无歧义；含 NUL/C0 的非法输入已被上方两处显式拒收
  const key = mergeable ? JSON.stringify([source.id, path.path]) : `unknown\u0000unverified-${counter.value++}`;
  let current = map.get(key);
  if (!current) {
    current = createAccumulator(key, source, path, kind, record);
    map.set(key, current);
  }
  current.origin = originFor(kind, current.origin);
  current.source_unknown ||= !source.known;
  current.path_verifiable ||= path.verifiable;
  current.unverified ||= !source.known || !path.verifiable;
  const reachable = sourceReachability(record, context, input.sources);
  if (reachable !== undefined) current.source_reachable = current.source_reachable === false ? false : reachable;
  if (kind === "artifacts" && typeof record.exists === "boolean") current.artifact_exists = record.exists;
  if (kind !== "artifacts" && typeof record.exists === "boolean") current.registration_exists = record.exists;
  if (typeof record.size === "number" && (current.size === null || kind === "artifacts")) current.size = record.size;
  if (typeof record.mtime === "number" && (current.mtime === null || kind === "artifacts" || record.mtime > current.mtime)) current.mtime = record.mtime;
  const sessionId = stringValue(record.session_id, record.sessionId, context.sessionId);
  if (sessionId && !current.session_ids.includes(sessionId)) current.session_ids.push(sessionId);
  addUnique(current.project_gids, projectIds(record, context));
  const deliveryGroup = explicitDeliveryGroup(record);
  if (deliveryGroup && !current.delivery_group_key) current.delivery_group_key = deliveryGroup;
}

function contextForSession(session: ArtifactViewSession): RegistrationContext {
  return {
    sessionId: stringValue(session.session_id, session.sessionId),
    projectGids: projectIds(session as Record<string, unknown>, { projectGids: [], source: { id: UNKNOWN_SOURCE, known: false } }),
    source: sourceState(session as Record<string, unknown>),
    cwd: stringValue(session.cwd, session.session_cwd),
    reachable: booleanValue(session.source_reachable, session.sourceReachable, session.reachable),
  };
}

function inputFrom(first: ArtifactViewInput | readonly ArtifactViewScanEntry[], sessions?: readonly ArtifactViewSession[], options?: Omit<ArtifactViewInput, "artifacts" | "sessions">): ArtifactViewInput {
  if (Array.isArray(first)) return { ...(options ?? {}), artifacts: first, sessions: sessions ?? [] } as ArtifactViewInput;
  return first as ArtifactViewInput;
}

export function deriveArtifactView(input: ArtifactViewInput): ArtifactViewRecord[];
export function deriveArtifactView(
  artifacts: readonly ArtifactViewScanEntry[],
  sessions?: readonly ArtifactViewSession[],
  options?: Omit<ArtifactViewInput, "artifacts" | "sessions">,
): ArtifactViewRecord[];
export function deriveArtifactView(
  first: ArtifactViewInput | readonly ArtifactViewScanEntry[],
  sessions?: readonly ArtifactViewSession[],
  options?: Omit<ArtifactViewInput, "artifacts" | "sessions">,
): ArtifactViewRecord[] {
  const input = inputFrom(first, sessions, options);
  const map = new Map<string, Accumulator>();
  const counter = { value: 0 };
  const root = input.artifacts_root;
  const scans = input.artifacts ?? input.artifact_scan ?? input.files ?? [];
  for (const scan of scans) {
    const source = sourceState(scan as Record<string, unknown>, { id: "local", known: true, reachable: true });
    addRecord(map, counter, "artifacts", scan as Record<string, unknown>, {
      source,
      projectGids: [],
    }, input, scan.artifacts_root ?? root);
  }
  for (const session of input.sessions ?? []) {
    const context = contextForSession(session);
    for (const item of session.artifacts ?? []) addRecord(map, counter, "session", item as Record<string, unknown>, context, input);
    for (const item of session.deliverables ?? []) addRecord(map, counter, "deliverable", item as Record<string, unknown>, context, input);
  }
  for (const item of input.registrations ?? []) addRecord(map, counter, "session", item as Record<string, unknown>, {
    sessionId: stringValue(item.session_id, item.sessionId),
    projectGids: projectIds(item as Record<string, unknown>, { projectGids: [], source: { id: UNKNOWN_SOURCE, known: false } }),
    source: sourceState(item as Record<string, unknown>),
    cwd: stringValue(item.cwd, item.session_cwd),
  }, input);
  for (const item of input.deliverables ?? []) addRecord(map, counter, "deliverable", item as Record<string, unknown>, {
    sessionId: stringValue(item.session_id, item.sessionId),
    projectGids: projectIds(item as Record<string, unknown>, { projectGids: [], source: { id: UNKNOWN_SOURCE, known: false } }),
    source: sourceState(item as Record<string, unknown>),
    cwd: stringValue(item.cwd, item.session_cwd),
  }, input);

  return [...map.values()].map((item) => {
    const unreachable = item.source_reachable === false || item.unverified;
    // #72A0（P2-3C）：缺证据不默认存在——unknown 态，exists=false，open/reveal 不开
    //（幽灵产物不再显示为可打开）；只有 artifacts scan 或登记校验明确报告 boolean
    // 存在才置 exists/missing
    const evidence = item.artifact_exists ?? item.registration_exists;
    const exists = evidence === true;
    const existence_state: ArtifactViewExistence = unreachable
      ? "unreachable"
      : evidence === undefined
        ? "unknown"
        : evidence
          ? "exists"
          : "missing";
    const derivedPrefix = item.derived_prefix_group;
    const missingOrUnreachable = existence_state !== "exists";
    const canOpen = existence_state === "exists";
    const canDownload = canOpen && item.origin === "artifacts";
    const parent = item.normalized_path ? normalizedPath(dirname(item.normalized_path)) : `unverified/${item.key}`;
    // #72A0（P2-3A）：分组键结构化编码（同 merge key 方案）防 "::" 碰撞；unknown
    // 组键沿用运行内 counter——unverified-${counter} 在本次投影内唯一即可，不作跨
    // 刷新稳定身份（客户端不得持久化该键，刷新后以 source+path 重新 join）
    const groupKey = item.unverified
      ? `unknown::待刷新/${item.key.replace("\u0000", "-")}`
      : JSON.stringify([item.source_id, parent]);
    return {
      source_id: item.unverified ? UNKNOWN_SOURCE : item.source_id,
      normalized_path: item.normalized_path,
      display_name: item.display_name,
      origin: item.origin,
      session_ids: [...item.session_ids],
      project_gids: [...item.project_gids],
      group_key: groupKey,
      exists,
      existence_state,
      availability: existence_state,
      status: existence_state,
      source_reachable: item.source_reachable ?? null,
      size: item.size,
      mtime: item.mtime,
      capabilities: {
        open: canOpen,
        download: canDownload,
        reveal: canOpen,
        retry: existence_state === "unreachable",
      },
      delivery_group_key: item.delivery_group_key,
      derived_prefix_group: derivedPrefix,
      derived_prefix_label: derivedPrefix ? "按文件名前缀推断" : null,
      collapsed: missingOrUnreachable,
      source_label: item.unverified ? UNKNOWN_LABEL : item.source_id,
      needs_refresh: item.unverified || existence_state === "unreachable",
    };
  });
}

export const buildArtifactView = deriveArtifactView;
export const projectArtifactView = deriveArtifactView;
