// R1 干跑（验收②）：生产盘只读——新判据逐卡分解 vs 旧判定（不在册即判）对照
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { reconcileBoardCards, ORPHAN_GRACE_MS, type ReconSession, type ReconDispatchRow } from "../src/board-recon.js";
import { listGroups, loadBoardFile } from "../src/projects.js";
import { readDispatchLogFile } from "../src/org.js";

const ORG = join(homedir(), ".cc-deck", "org");
const DATA = join(homedir(), ".cc-deck", "data");
const now = Date.now();

// sessions 代理：events.ndjson 尾窗 2000 行的 SESSION_UPDATED/SESSION_END 终态/活态
const sessions = new Map<string, ReconSession>();
try {
  const tail = readFileSync(join(DATA, "events.ndjson"), "utf-8").slice(-2_000_000).split("\n").slice(-2000);
  for (const line of tail) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      const sid = ev.session_id || (ev.payload && ev.payload.session_id);
      if (!sid) continue;
      if (ev.type === "SESSION_UPDATED" || ev.type === "SESSION_END") {
        sessions.set(sid, {
          session_id: sid,
          status: ev.payload?.status ?? sessions.get(sid)?.status,
          done_reason: ev.payload?.done_reason ?? sessions.get(sid)?.done_reason ?? null,
          last_active_at: ev.ts ? ev.ts < 1e12 ? ev.ts * 1000 : ev.ts : (sessions.get(sid)?.last_active_at ?? 0),
        });
      }
    } catch {}
  }
} catch {}

const boards: Array<{ gid: string; board: NonNullable<ReturnType<typeof loadBoardFile>> }> = [];
for (const g of listGroups(ORG)) {
  if (g.status !== "active") continue;
  const b = loadBoardFile(g.id, ORG);
  if (b) boards.push({ gid: g.id, board: b });
}
const log: ReconDispatchRow[] = readDispatchLogFile(ORG, 20_000).map((x) => ({ id: x.id, status: x.status }));

console.log(`[dryrun] boards=${boards.length} sessions(events 尾窗代理)=${sessions.size} 台账行=${log.length} 宽限=${ORPHAN_GRACE_MS / 60000}min`);
console.log("— 旧判定（不在册即孤儿）清单:");
for (const { gid, board } of boards) for (const e of board.entries) {
  if (e.status !== "claimed" || !e.owner_session) continue;
  if (!sessions.has(e.owner_session)) console.log(`  OLD-JUDGE ${e.id}「${String(e.text).slice(0, 24)}」owner ${e.owner_session.slice(0, 8)} 不在册→归位`);
}
const flag = new Set<string>();
const r1 = reconcileBoardCards({ boards, sessions: [...sessions.values()], dispatchLog: log, now, previouslyFlagged: new Set(), flaggedNow: flag });
console.log(`— 新判据拍1：actions=${r1.actions.length}（advisory ${r1.actions.filter(a=>a.advisory).length}）候选标记=${flag.size}；mismatch=${r1.mismatch ?? "null"}`);
const r2 = reconcileBoardCards({ boards, sessions: [...sessions.values()], dispatchLog: log, now, previouslyFlagged: flag, flaggedNow: new Set() });
console.log(`— 新判据拍2（同形态复核）：actions=${r2.actions.length}`);
for (const a of r2.actions) console.log(`  NEW-JUDGE ${a.entryId}「${a.text}」${a.reason}${a.advisory ? "（advisory 仅提醒）" : "→归位"}：${a.detail}`);
