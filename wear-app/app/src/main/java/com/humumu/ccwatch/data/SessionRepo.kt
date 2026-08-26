package com.humumu.ccwatch.data

import com.humumu.ccwatch.protocol.RecentEvent
import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.WatchCommand
import kotlinx.coroutines.flow.StateFlow

interface SessionRepo {
    /** 会话快照流；断连时保留最后已知数据但 connected=false。 */
    val sessions: StateFlow<List<SessionState>>

    /** 通道是否可用（relay=WS 已连；GMS=手机节点可达）。demo 恒为 true。 */
    val connected: StateFlow<Boolean>

    /** 各会话时间线（sessionId -> 事件列表，旧→新）。GMS 网关路径暂无日志，为空表。 */
    val timelines: StateFlow<Map<String, List<RecentEvent>>>

    fun sendCommand(cmd: WatchCommand)

    fun close() {}
}
