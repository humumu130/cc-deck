// ---------- 组织域导入器（M11-C1）：orgDir JSON 事实源 → 五表 ----------
// 消费面：org.json（Leader 锚）+ projects.json（组索引）+ confirms.json（确认单）
//   → project / "group" / member / group_member / org_confirm。
// boards/*.json 不在本单消费面（冻结件 §4：boards.entries→task、lessons→lesson，归 D/E 线）。
//
// importer 范式（D/E 线模板，五要点）：
//   1. 入口 importXxx(port, sourceDir, opts)——port 显式传入；事务内聚本函数（快照同步原子，
//      失败 rollback 留旧快照；进程中断=事务未提交=旧快照完整+checkpoint 未写=下次重扫，自洽）。
//   2. 逐源文件消费 B2 checkpoint 五元组：JSON 全量源是文件级语义——命中=整文件跳过（快进），
//      失效=整文件重扫；offset 恒=lineCount（JSON 无逐行续跑面，ndjson 源归 D 线用 offset 续跑）。
//   3. 失效即域重扫：清域（子表→父表）→重灌→按源清旧 loss→重灌→回写三源 checkpoint，单事务。
//      「重复运行行数不增」=checkpoint 快进（文件没变零写入）×2 + 确定性 id（重灌覆盖不重复）双保险。
//   4. 坏行走 B2 loss writer：元素级坏（缺字段/词表外/悬空引用/缺归因）拒入或写 NULL+落账，
//      不造关联不阻断；整文件 JSON.parse 失败=该源单条 loss+零导入，其余源继续。
//   5. 全部行 id 确定性推导（sha1(稳定键)前 12 位），跨次重跑同源同 id，天然幂等。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { sha12, statThenRead } from "./import-util.js";
import { join } from "node:path";
import type { StoragePort } from "./port.js";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { appendLoss, listLoss } from "./loss-report.js";

/** 导入映射逻辑版本：映射代码升级时 bump→全部源失效强制重扫（与 DB user_version 正交）。 */
export const ORG_IMPORT_SCHEMA_VERSION = 1;

/** 词表（与 DDL CHECK 一致；词表外=拒入+loss，不猜）。 */
const GROUP_STATUS = new Set(["pending", "active", "parked", "archived"]);
const GROUP_TIER = new Set(["轻立项", "正经立项"]);
const CONFIRM_KIND = new Set(["project-create", "tier-change", "suggest-hold", "archive", "revive"]);
const CONFIRM_STATUS = new Set(["pending", "approved", "rejected"]);

export interface OrgImportCounts {
  project: number; group: number; member: number; groupMember: number; orgConfirm: number;
}

export interface OrgImportResult {
  /** true=三源 checkpoint 全命中，域零写入快进。 */
  skipped: boolean;
  /** 本次落库后五表行数（快进时为实数 COUNT）。 */
  counts: OrgImportCounts;
  /** 本次 loss 台账净条数（快进时为存量实数）。 */
  loss: number;
  /** 实际重扫的源文件（快进为空数组）。 */
  rescanned: string[];
}

interface ObservedSource {
  name: string;
  file: string;
  mtimeMs: number;
  lineCount: number;
  text: string | null; // null=文件缺失
}

function observe(file: string, name: string): ObservedSource {
  if (!existsSync(file)) return { name, file, mtimeMs: 0, lineCount: 0, text: null };
  const obs = statThenRead(file); // stat 先于 read 定稿序（权威注释见 import-util.ts，本函数是定稿序出处）
  const lines = obs.text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { name, file, mtimeMs: obs.mtimeMs, lineCount: lines.length, text: obs.text };
}

// ---------- 中间行模型（解析产物，事务内落库） ----------
interface GroupRow {
  id: string; projectRef: string; name: string; anchorDir: string; status: string; tier: string;
  singleCard: number; headcountJson: string; roleDefaultsJson: string; holdSuggestedAt: number | null;
  archiveNote: string | null; createdAt: number; updatedAt: number;
}
interface HeadcountRef { gid: string; role: string; engine: string; sessionId: string | null; provider: string | null; model: string | null; groupCreatedAt: number; groupUpdatedAt: number }
interface MemberRow {
  id: string; stableIdentity: string; displayName: string; role: string; engine: string | null;
  provider: string | null; model: string | null; externalSid: string | null; joinedAt: number; ts: number;
  groupIds: string[];
}
interface ConfirmRow {
  id: string; kind: string; groupId: string | null; title: string; reason: string;
  payloadJson: string; status: string; createdAt: number; decidedAt: number | null; decidedBy: string | null;
}

function countAll(port: StoragePort): OrgImportCounts {
  const n = (sql: string): number => port.query<{ n: number }>(sql)[0]?.n ?? -1;
  return {
    project: n("SELECT COUNT(*) AS n FROM project"),
    group: n(`SELECT COUNT(*) AS n FROM "group"`),
    member: n("SELECT COUNT(*) AS n FROM member"),
    groupMember: n("SELECT COUNT(*) AS n FROM group_member"),
    orgConfirm: n("SELECT COUNT(*) AS n FROM org_confirm"),
  };
}

/**
 * 组织域导入：orgDir JSON 事实源快照同步进五表。幂等——同源同版本重跑走 checkpoint 快进；
 * 任一源变化/失效→全域清空重灌（orgDir 是五表唯一生产者，域清=「清该源已导入行」的语义等价
 * 强实现：覆盖组删除/成员退出等一切删除面，无残留）。port 事务边界内聚本函数。
 */
export function importOrg(port: StoragePort, orgDir: string, opts?: { schemaVersion?: number }): OrgImportResult {
  const schemaVersion = opts?.schemaVersion ?? ORG_IMPORT_SCHEMA_VERSION;
  const sources = [
    observe(join(orgDir, "org.json"), "org.json"),
    observe(join(orgDir, "projects.json"), "projects.json"),
    observe(join(orgDir, "confirms.json"), "confirms.json"),
  ];
  const current = (s: ObservedSource) => ({ mtimeMs: s.mtimeMs, lineCount: s.lineCount, schemaVersion });
  const allValid = sources.every((s) => readCheckpoint(port, s.file, current(s)) !== null);

  if (allValid) {
    return { skipped: true, counts: countAll(port), loss: listLoss(port).filter((l) => sources.some((s) => s.file === l.sourcePath)).length, rescanned: [] };
  }

  // ---------- 解析（纯函数段：源文本 → 中间行 + loss 待落账） ----------
  const losses: { source: ObservedSource; lineNo: number; reason: string; excerpt: string }[] = [];
  const groups: GroupRow[] = [];
  const validGroupIds = new Set<string>();
  const groupLineNo = new Map<string, number>();
  const headcountRefs: HeadcountRef[] = [];
  const confirms: ConfirmRow[] = [];

  // -- org.json → Leader member（锚缺失=未建组织，Leader 不导，合法态）
  const orgSrc = sources[0];
  let leader: MemberRow | null = null;
  if (orgSrc.text !== null) {
    try {
      const a = JSON.parse(orgSrc.text) as { version?: unknown; leader_session_id?: unknown; created_at?: unknown };
      if (a.version !== 1 || typeof a.leader_session_id !== "string" || !a.leader_session_id) {
        losses.push({ source: orgSrc, lineNo: 1, reason: "bad-field", excerpt: orgSrc.text.slice(0, 200) });
      } else {
        const identity = `${orgDir}@leader@`;
        leader = {
          id: `mem-${sha12(identity)}`, stableIdentity: identity, displayName: "Leader", role: "leader",
          engine: null, provider: null, model: null, externalSid: a.leader_session_id,
          joinedAt: typeof a.created_at === "number" ? a.created_at : 0, ts: typeof a.created_at === "number" ? a.created_at : 0,
          groupIds: [],
        };
      }
    } catch {
      losses.push({ source: orgSrc, lineNo: 1, reason: "bad-json", excerpt: orgSrc.text.slice(0, 200) });
    }
  }

  // -- projects.json → project（anchor 归并）+ group + headcount(member/group_member 原料)
  const projectsSrc = sources[1];
  if (projectsSrc.text !== null) {
    try {
      const pf = JSON.parse(projectsSrc.text) as { groups?: unknown };
      if (!Array.isArray(pf.groups)) throw new Error("groups 非数组");
      (pf.groups as unknown[]).forEach((raw, idx) => {
        const lineNo = idx + 1; // groups[] 元素序（1-based）
        const g = raw as Record<string, unknown>;
        let groupValid = true;
        if (typeof g.id !== "string" || !g.id || typeof g.name !== "string" || typeof g.anchor_dir !== "string" || !g.anchor_dir) {
          losses.push({ source: projectsSrc, lineNo, reason: "missing-field", excerpt: JSON.stringify(g).slice(0, 200) });
          groupValid = false;
        } else if (typeof g.status !== "string" || !GROUP_STATUS.has(g.status) || typeof g.tier !== "string" || !GROUP_TIER.has(g.tier)) {
          losses.push({ source: projectsSrc, lineNo, reason: "bad-field", excerpt: JSON.stringify({ id: g.id, status: g.status, tier: g.tier }) });
          groupValid = false;
        }
        const createdAt = typeof g.created_at === "number" ? g.created_at : 0;
        const updatedAt = typeof g.updated_at === "number" ? g.updated_at : createdAt;
        if (groupValid && typeof g.id === "string") {
          groups.push({
            id: g.id, projectRef: g.anchor_dir as string, name: g.name as string, anchorDir: g.anchor_dir as string,
            status: g.status as string, tier: g.tier as string,
            singleCard: g.single_card === true ? 1 : 0,
            headcountJson: JSON.stringify(Array.isArray(g.headcount) ? g.headcount : []),
            roleDefaultsJson: JSON.stringify(g.role_defaults ?? {}),
            holdSuggestedAt: typeof g.hold_suggested_at === "number" ? g.hold_suggested_at : null,
            archiveNote: typeof g.archive_note === "string" ? g.archive_note : null,
            createdAt, updatedAt,
          });
          validGroupIds.add(g.id);
          groupLineNo.set(g.id, lineNo);
        }
        // headcount 是成员存在的事实（冻结件 §4：headcount 是快照，不冒充成员）——组拒入也照导
        // member；组缺失导致的关系悬空在落库段跳过并落账，不造关联
        if (Array.isArray(g.headcount)) {
          (g.headcount as unknown[]).forEach((h) => {
            const e = h as Record<string, unknown>;
            if (typeof e.role !== "string" || !e.role) {
              losses.push({ source: projectsSrc, lineNo, reason: "missing-field", excerpt: JSON.stringify({ gid: g.id, entry: e }).slice(0, 200) });
              return;
            }
            headcountRefs.push({
              gid: typeof g.id === "string" ? g.id : "", role: e.role,
              engine: typeof e.engine === "string" ? e.engine : "",
              sessionId: typeof e.session_id === "string" ? e.session_id : null,
              provider: typeof e.provider === "string" ? e.provider : null,
              model: typeof e.model === "string" ? e.model : null,
              groupCreatedAt: createdAt, groupUpdatedAt: updatedAt,
            });
          });
        }
      });
    } catch {
      losses.push({ source: projectsSrc, lineNo: 1, reason: "bad-json", excerpt: projectsSrc.text.slice(0, 200) });
    }
  }

  // project 归并：同 anchor_dir 同 project（冻结件 §4：无 project_id 旧组按 anchor fingerprint 归并），
  // name 取最早组的（created_at 最小者）
  const projectByAnchor = new Map<string, { id: string; name: string; ts: number }>();
  for (const g of groups) {
    const seen = projectByAnchor.get(g.anchorDir);
    if (seen) {
      if (g.createdAt < seen.ts) { seen.ts = g.createdAt; seen.name = g.name; }
      continue;
    }
    projectByAnchor.set(g.anchorDir, { id: `proj-${sha12(g.anchorDir)}`, name: g.name, ts: g.createdAt });
  }

  // member 归并：stable_identity=<orgDir>@<role>@<engine>@<session>（M12-8 FIX-1 案 B：identity
  // 混入 session 维度——两卡同 role 同引擎不再共 member_id，同组 UNIQUE 炸根除、每
  // (session,role,engine) 一行保真编制；下游勘察 session.member_id 恒 NULL/成员投影走
  // headcount_json 直还/dispatch 归因走 session.member_id，三面零联动）；跨组历史写 archive_json
  const memberByIdentity = new Map<string, MemberRow>();
  for (const h of headcountRefs) {
    const identity = `${orgDir}@${h.role}@${h.engine}@${h.sessionId ?? ""}`;
    const id = `mem-${sha12(identity)}`;
    const seen = memberByIdentity.get(identity);
    if (seen) {
      seen.ts = Math.max(seen.ts, h.groupUpdatedAt);
      if (!seen.groupIds.includes(h.gid)) seen.groupIds.push(h.gid);
      continue;
    }
    memberByIdentity.set(identity, {
      id, stableIdentity: identity, displayName: h.role, role: h.role,
      engine: h.engine === "" ? null : h.engine, provider: h.provider, model: h.model,
      externalSid: h.sessionId, joinedAt: h.groupCreatedAt, ts: h.groupUpdatedAt, groupIds: [h.gid],
    });
  }

  // -- confirms.json → org_confirm（词表外拒入不猜；悬空 gid 写 NULL+loss；decided_by 映射见下）
  const confirmsSrc = sources[2];
  if (confirmsSrc.text !== null) {
    try {
      const cf = JSON.parse(confirmsSrc.text) as unknown;
      // 格式两吃（C2FIX P1 处置）：裸数组（fixture/历史形）或 {confirms:[…]} 包裹形——后者
      // 是生产唯一写者 writeConfirms（projects.ts:625）的落盘形，读法同 projects.ts:152 取
      // .groups；冻结件不格式钦定处从生产现实。其余形状仍拒（bad-json）。
      const confirmList: unknown[] | null = Array.isArray(cf)
        ? cf
        : (cf !== null && typeof cf === "object" && Array.isArray((cf as { confirms?: unknown }).confirms)
          ? (cf as { confirms: unknown[] }).confirms
          : null);
      if (confirmList === null) throw new Error("根非数组且非 {confirms:[…]} 包裹形");
      confirmList.forEach((raw, idx) => {
        const lineNo = idx + 1;
        const c = raw as Record<string, unknown>;
        const missing = typeof c.id !== "string" || !c.id || typeof c.kind !== "string" || typeof c.status !== "string"
          || typeof c.title !== "string" || typeof c.reason !== "string" || typeof c.created_at !== "number";
        const kindBad = typeof c.kind === "string" && !CONFIRM_KIND.has(c.kind);
        const statusBad = typeof c.status === "string" && !CONFIRM_STATUS.has(c.status);
        if (missing || kindBad || statusBad) {
          losses.push({ source: confirmsSrc, lineNo, reason: missing ? "missing-field" : "bad-field", excerpt: JSON.stringify(c).slice(0, 200) });
          return;
        }
        // 归因：payload.gid 悬空→NULL+loss；缺失→NULL+loss；绝不造关联
        const gid = typeof (c.payload as Record<string, unknown> | undefined)?.gid === "string" ? (c.payload as Record<string, unknown>).gid as string : null;
        let groupId: string | null = null;
        if (gid !== null) {
          if (validGroupIds.has(gid)) groupId = gid;
          else losses.push({ source: confirmsSrc, lineNo, reason: "dangling-ref", excerpt: JSON.stringify({ id: c.id, gid }).slice(0, 200) });
        } else {
          losses.push({ source: confirmsSrc, lineNo, reason: "missing-attribution", excerpt: JSON.stringify({ id: c.id }).slice(0, 200) });
        }
        // decided_by 映射规则（回单列明）："leader"→Leader member id；其他非空→历史原串保留（无 FK 不猜映射）；空→NULL
        let decidedBy: string | null = typeof c.decided_by === "string" && c.decided_by ? c.decided_by : null;
        if (decidedBy === "leader" && leader !== null) decidedBy = leader.id;
        // 该点六字段存在性与类型已验，显式落局部（跨语句收窄不传播）
        const cid = c.id as string;
        const kind = c.kind as string;
        const status = c.status as string;
        const title = c.title as string;
        const reason = c.reason as string;
        const createdAt = c.created_at as number;
        confirms.push({
          id: cid, kind, groupId, title, reason,
          payloadJson: JSON.stringify(c.payload ?? {}), status,
          createdAt,
          decidedAt: typeof c.decided_at === "number" ? c.decided_at : null,
          decidedBy,
        });
      });
    } catch {
      losses.push({ source: confirmsSrc, lineNo: 1, reason: "bad-json", excerpt: confirmsSrc.text.slice(0, 200) });
    }
  }

  // ---------- 落库（单事务：域清→重灌→loss→checkpoint） ----------
  port.begin();
  try {
    // 清域（子表先于父表；orgDir 是五表唯一生产者，域清=清该源已导入行）+ 清三源旧 loss
    port.exec("DELETE FROM group_member");
    port.exec("DELETE FROM org_confirm");
    port.exec("DELETE FROM member");
    port.exec(`DELETE FROM "group"`);
    port.exec("DELETE FROM project");
    port.exec("DELETE FROM import_loss WHERE source_path IN (?, ?, ?)", [orgSrc.file, projectsSrc.file, confirmsSrc.file]);

    for (const [anchorDir, p] of projectByAnchor) {
      port.exec(
        "INSERT INTO project (id, name, dir_fingerprint, anchor_dir, is_default, is_hidden, deleted_at, ts) VALUES (?, ?, ?, ?, 0, 0, NULL, ?)",
        [p.id, p.name, createHash("sha1").update(anchorDir).digest("hex"), anchorDir, p.ts],
      );
    }
    for (const g of groups) {
      const p = projectByAnchor.get(g.anchorDir);
      port.exec(
        `INSERT INTO "group" (id, project_id, name, anchor_dir, status, tier, single_card, headcount_json, role_defaults_json, hold_suggested_at, archive_note, workflow_profile, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'engineering', ?, ?)`,
        [g.id, p?.id ?? null, g.name, g.anchorDir, g.status, g.tier, g.singleCard, g.headcountJson, g.roleDefaultsJson, g.holdSuggestedAt, g.archiveNote, g.createdAt, g.updatedAt],
      );
    }
    const allMembers = leader !== null ? [leader, ...memberByIdentity.values()] : [...memberByIdentity.values()];
    for (const m of allMembers) {
      // archive_json 跨组历史只记库内合法组（拒入组的关系已落 dangling 账，库内无对应物不写）
      const validGroups = m.groupIds.filter((gid) => validGroupIds.has(gid));
      port.exec(
        `INSERT INTO member (id, stable_identity, display_name, business_role, command_role, task_participation, engine, provider, model, external_sid, joined_at, retired_at, last_heartbeat_at, last_business_log_at, status, archive_json, ts)
         VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, NULL, NULL, NULL, 'active', ?, ?)`,
        [m.id, m.stableIdentity, m.displayName, m.role, m.role, m.engine, m.provider, m.model, m.externalSid, m.joinedAt,
          validGroups.length > 1 ? JSON.stringify({ groups: validGroups }) : "{}", m.ts],
      );
    }
    // 关系落库去重（M12-8 FIX-1）：headcount 是快照，同卡重复认领条目（同 gid+session+role+engine）
    // 是同一认领的多次记录——group_member PK(group_id,member_id) 每 (session,role,engine) 恰一行
    const seenRef = new Set<string>();
    for (const h of headcountRefs) {
      if (!validGroupIds.has(h.gid)) {
        // 组拒入/组缺 id→关系悬空：不造关联，落账（file:line 指向组行）
        losses.push({ source: projectsSrc, lineNo: groupLineNo.get(h.gid) ?? 0, reason: "dangling-ref", excerpt: JSON.stringify({ gid: h.gid, role: h.role, engine: h.engine }).slice(0, 200) });
        continue;
      }
      const identity = `${orgDir}@${h.role}@${h.engine}@${h.sessionId ?? ""}`;
      const memId = `mem-${sha12(identity)}`;
      const gmKey = `${h.gid}@${memId}`;
      if (seenRef.has(gmKey)) continue;
      seenRef.add(gmKey);
      port.exec(
        "INSERT INTO group_member (group_id, member_id, command_role, task_participation, joined_at, retired_at, archive_json) VALUES (?, ?, ?, NULL, ?, NULL, '{}')",
        [h.gid, memId, h.role, h.groupCreatedAt],
      );
    }
    for (const c of confirms) {
      port.exec(
        "INSERT INTO org_confirm (id, kind, group_id, title, reason, payload_json, status, created_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [c.id, c.kind, c.groupId, c.title, c.reason, c.payloadJson, c.status, c.createdAt, c.decidedAt, c.decidedBy],
      );
    }
    for (const l of losses) appendLoss(port, { sourcePath: l.source.file, lineNo: l.lineNo, reason: l.reason, excerpt: l.excerpt });
    for (const s of sources) writeCheckpoint(port, { path: s.file, mtimeMs: s.mtimeMs, lineCount: s.lineCount, offset: s.lineCount, schemaVersion });
    port.commit();
  } catch (err) {
    port.rollback();
    throw new Error(`import-org: 组织域导入失败已回滚（保留旧快照）——${err instanceof Error ? err.message : String(err)}`);
  }

  return { skipped: false, counts: countAll(port), loss: losses.length, rescanned: sources.filter((s) => s.text !== null).map((s) => s.file) };
}
