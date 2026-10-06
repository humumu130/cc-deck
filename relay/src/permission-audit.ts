// P81-5 权限审计写面（081 §6.1 审计清单+§6.3「拒绝也写审计」）——经 StoragePort 单写者
// 落 permission_audit 表（schema v3），不新建 JSON 账（D10 口径）。三块：
//   ①真实判定（cwd→dir_scope / 进程→environment）——判不出**显式返回 "unknown"**（P81-3/4
//     头注钉死的接线纪律：判定缺位走 fail-closed，绝不缺席两维）；
//   ②appendPermissionAudit（尽力而为：审计失败只 warn 不抛——绝不阻断开卡/派单主路径，
//     appendDispatch 同款纪律）；
//   ③readPermissionAudit（测试+审计查询面）。
// 本模块零策略逻辑（求值归 permission-policy.ts 纯函数）；本文件是 audit 域唯一写者。
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { ensureStore } from "./storage/read-mode.js";
import { orgDir } from "./org.js";
import type { StoragePort } from "./storage/port.js";

/** 目录域/环境域三值（§6.1 production/sandbox；unknown=判不出 fail-closed）。 */
export type DirScope = "production" | "sandbox" | "unknown";
export type EnvScope = "production" | "sandbox" | "unknown";

/** cwd→目录域判定（会话级，§6.1「服务端识别运行环境和工作目录」）。最小保守集：
 * - ~/.cc-deck 前缀（组织数据域，§6.1「测试不得写 ~/.cc-deck 组织数据」同源）或家目录
 *   本体 → production（敏感面 bypass 禁区）；
 * - 空/非绝对/解析异常 → **unknown（判不出显式回 unknown，绝不缺席——P81-3/4 纪律）**；
 * - 其余（用户项目目录等）→ sandbox（§6.1「沙盒路径必须与生产目录隔离」）。
 * 判定集收紧/放宽是纯函数一处改；真实生产目录清单若有扩充（如 relay 源码树）后续单加。 */
export function resolveDirScope(cwd: string | null | undefined): DirScope {
  if (!cwd || typeof cwd !== "string") return "unknown";
  let abs: string;
  try {
    if (!isAbsolute(cwd)) return "unknown";
    abs = resolve(cwd);
  } catch {
    return "unknown";
  }
  const home = homedir();
  const orgRoot = resolve(home, ".cc-deck");
  if (abs === orgRoot || abs.startsWith(orgRoot + "/")) return "production";
  if (abs === home) return "production";
  return "sandbox";
}

/** 进程→环境域判定（进程级）。CCR_ENV 显式声明优先（测试/演练可控开关）；
 * 否则 port===8787（生产 relay 缺省端口）→production、非 8787→sandbox（测试/开发端口）；
 * port 非法→unknown。 */
export function resolveEnvScope(port: number | null | undefined): EnvScope {
  const explicit = process.env.CCR_ENV;
  if (explicit === "production" || explicit === "sandbox") return explicit;
  if (explicit === "unknown") return "unknown";
  if (port === undefined || port === null || !Number.isFinite(port) || port <= 0) return "unknown";
  return port === 8787 ? "production" : "sandbox";
}

/** 审计行（策略核 PolicyResult 十字段的存储投影——落库行宽型 string，不背核严格联合；
 * 十字段=requested/normalized/effective/native/capability_state/engine/reason/
 * policy_source+environment/dir_scope（§6.1 审计清单两维））。
 * session_id：COMMAND_CREATE 成功=新会话 id、拒=null；dispatchWorker 成功=承接会话、拒=null。
 * command_id：COMMAND_CREATE=wire 命令号；dispatchWorker=API 直调无 command→存 dispatchId
 * （触发单号，追溯语义等价——备案）。 */
export interface PermissionAuditRow {
  requested_mode: string | null;
  normalized_mode: string | null;
  effective_mode: string;
  native_mode: string | null;
  capability_state: string | null;
  engine: string | null;
  reason: string;
  policy_source: string | null;
  environment: EnvScope | null;
  dir_scope: DirScope | null;
  tier: string | null;
  actor: string | null;
  session_id: string | null;
  command_id: string | null;
  created_at: number;
}

/** 审计端口（ensureStore 端口缓存复用——热写零快进税；tasksDir 缺省 <dataDir>/tasks
 * 与 resolveDirs 缺省口径一致）。 */
export function auditStore(dataDir: string): StoragePort {
  return ensureStore({ dataDir, orgDir: orgDir(), tasksDir: join(dataDir, "tasks") });
}

/** 尽力而为落一行（成功与拒绝都落——§6.3「拒绝也写审计」；B8 修正：拒单审计面并入，
 * 含 preflight 拒/未知引擎拒）。写失败只 warn 不抛（审计绝不阻断主路径）。 */
export function appendPermissionAudit(port: StoragePort, row: PermissionAuditRow): void {
  try {
    port.exec(
      `INSERT INTO permission_audit (requested_mode, normalized_mode, effective_mode, native_mode, capability_state, engine, reason, policy_source, environment, dir_scope, tier, actor, session_id, command_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.requested_mode, row.normalized_mode, row.effective_mode, row.native_mode, row.capability_state, row.engine, row.reason, row.policy_source, row.environment, row.dir_scope, row.tier, row.actor, row.session_id, row.command_id, row.created_at],
    );
  } catch (e) {
    console.warn(`[permission-audit] 审计写入失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 审计回读（created_at 倒序 max 行；测试锁+审计查询面）。 */
export function readPermissionAudit(port: StoragePort, max = 100): PermissionAuditRow[] {
  return port
    .query<Record<string, unknown>>(`SELECT * FROM permission_audit ORDER BY id DESC LIMIT ?`, [max])
    .map((r) => ({
      requested_mode: (r.requested_mode as string | null) ?? null,
      normalized_mode: (r.normalized_mode as string | null) ?? null,
      effective_mode: r.effective_mode as string,
      native_mode: (r.native_mode as string | null) ?? null,
      capability_state: (r.capability_state as string | null) ?? null,
      engine: (r.engine as string | null) ?? null,
      reason: r.reason as string,
      policy_source: (r.policy_source as string | null) ?? null,
      environment: (r.environment as EnvScope | null) ?? null,
      dir_scope: (r.dir_scope as DirScope | null) ?? null,
      tier: (r.tier as string | null) ?? null,
      actor: (r.actor as string | null) ?? null,
      session_id: (r.session_id as string | null) ?? null,
      command_id: (r.command_id as string | null) ?? null,
      created_at: r.created_at as number,
    }));
}
