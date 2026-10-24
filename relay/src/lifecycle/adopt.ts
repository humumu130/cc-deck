// W-SPLIT-S5 生命周期域①：收养/adopt（session-manager 方法体逐字搬出，仅 this.→mgr.）。
// 搬运纪律同 S2/S3 样板：逻辑零改动（含注释原样）；类面留委托壳（public 接口零变）。
import type { ReplayedSession } from "../history.js";

const MAX_SESSIONS = 20; // 随迁常量（原 session-manager :483 同值——单源随件走，S6 若有第二消费者再提公共）

// 样板参数：真身 SessionManager——any 网关为跨 private 成员边界（行为等价由
// test-dispatch + parity 锁死，非类型信任面）

// Relay 重启后收养历史会话。#247 W-READONLY-KILL（用户铁口径 2026-10-24）：收养
// **不再一律降级 historical**——旧语义「仅展示不可操作」曾把重启窗口期用户本机活跃
// 终端会话（external，rea/修图）锁成只读三次实锤。现口径：
//   external：收养即激活（historical=false，自愈回写误标存量）——transcript 在=EXT_INPUT
//     注入链可用，CLI 进程态由 bridge 存活自愈另行修正；
//   managed：保留重放原值（true=状态分组语义「agent 已断开」，非操作锁——web canCmd
//     已退役 + COMMAND_MESSAGE 对无 agent 会话走 resumeAgent 自动拉起，发送即继续）
export function adoptReplayed(mgr: any, replayed: Map<string, ReplayedSession>): number {
  // 活跃度优先：按 updated_at 倒序收养，超出上限丢最久未动的
  //（按 started_at 会把"创建早但一直在用"的长期会话挤出去，重启即丢整条时间线）
  const entries = [...replayed.entries()].sort((a, b) => b[1].state.updated_at - a[1].state.updated_at);
  let adopted = 0;
  for (const [id, rs] of entries) {
    if (mgr.sessions.size >= MAX_SESSIONS) break;
    if (rs.state.external) rs.state.historical = false;
    // #53 手动命名跨重启：改名虽双写（overrides 文件 + 事件帧），但事件流压缩每会话
    // 只留最近 50 条状态帧，忙会话的改名帧会被挤掉——title-overrides.json 才是权威，
    // 收养时套用（managed/external 通吃），否则重启后名字退回首条 prompt 派生名
    const ov = mgr.titleOverrides[id];
    if (ov) {
      rs.state.title = ov;
      rs.state.title_locked = true;
    }
    mgr.sessions.set(id, { agent: null, state: rs.state, logs: rs.logs, lastUpdateEmit: 0, lastProgressAt: 0, lastProgressKind: "", unacked: [], wd: { phase: "idle", recoveries: [], gaveUp: false }, streamGen: 0, activitySeq: 0 });
    mgr.applyDeclaredDeliverables(id);
    adopted++;
  }
  return adopted;
}
