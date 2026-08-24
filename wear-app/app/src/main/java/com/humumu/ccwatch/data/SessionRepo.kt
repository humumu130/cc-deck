package com.humumu.ccwatch.data

import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.WatchCommand
import kotlinx.coroutines.flow.StateFlow

interface SessionRepo {
    /** 会话快照流；手机未连接时 connected=false。 */
    val sessions: StateFlow<List<SessionState>>
    /** 手机节点是否可达。demo 仓库恒为 true。 */
    val connected: StateFlow<Boolean>

    fun sendCommand(cmd: WatchCommand)

    fun close() {}
}
