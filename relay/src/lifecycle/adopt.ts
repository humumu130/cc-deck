// W-SPLIT-S5 生命周期域①：收养/adopt（session-manager 方法体逐字搬出，仅 this.→mgr.）。
// 搬运纪律同 S2/S3 样板：逻辑零改动（含注释原样）；类面留委托壳（public 接口零变）。
import type { ReplayedSession } from "../history.js";

const MAX_SESSIONS = 20; // 随迁常量（原 session-manager :483 同值——单源随件走，S6 若有第二消费者再提公共）

// 样板参数：真身 SessionManager——any 网关为跨 private 成员边界（行为等价由
// test-dispatch + parity 锁死，非类型信任面）

// Relay 重启后收养历史会话（agent 为空，仅展示不可操作）
export function adoptReplayed(mgr: any, replayed: Map<string, ReplayedSession>): number {
  // 活跃度优先：按 updated_at 倒序收养，超出上限丢最久未动的
  //（按 started_at 会把"创建早但一直在用"的长期会话挤出去，重启即丢整条时间线）
  const entries = [...replayed.entries()].sort((a, b) => b[1].state.updated_at - a[1].state.updated_at);
  let adopted = 0;
  for (const [id, rs] of entries) {
    if (mgr.sessions.size >= MAX_SESSIONS) break;
    rs.state.historical = true;
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
