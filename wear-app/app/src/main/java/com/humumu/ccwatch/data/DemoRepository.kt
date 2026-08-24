package com.humumu.ccwatch.data

import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.SessionStats
import com.humumu.ccwatch.protocol.SessionStatus
import com.humumu.ccwatch.protocol.WaitingRequest
import com.humumu.ccwatch.protocol.WatchCommand
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

/** 演示仓库：3 个会话，状态随时间轮转，用于在无手机环境下演示全部 UI 状态与动画。 */
class DemoRepository : SessionRepo {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val now get() = System.currentTimeMillis()

    private val _sessions = MutableStateFlow(buildSessions())
    override val sessions: StateFlow<List<SessionState>> = _sessions.asStateFlow()

    override val connected: StateFlow<Boolean> = MutableStateFlow(true)

    private var phase = 0

    init {
        scope.launch {
            while (isActive) {
                delay(4000)
                phase = (phase + 1) % 5
                _sessions.value = buildSessions()
            }
        }
    }

    private fun buildSessions(): List<SessionState> {
        val t = now
        return listOf(
            SessionState(
                sessionId = "demo-1",
                relaySessionId = "r-1",
                cwd = "D:\\dev\\cc-watch",
                title = "修复登录超时",
                model = "glm-4.7",
                status = when (phase) {
                    0, 1 -> SessionStatus.WORKING
                    2 -> SessionStatus.WAITING
                    3 -> SessionStatus.ERROR
                    else -> SessionStatus.DONE
                },
                actionSummary = when (phase) {
                    2 -> "等待确认：写入 config.ts"
                    3 -> "编译失败：类型不匹配"
                    4 -> "全部测试通过"
                    else -> "正在重构 auth.ts 第 42 行"
                },
                startedAt = t - 200_000,
                updatedAt = t,
                waitingRequest = if (phase == 2) WaitingRequest(
                    requestId = "req-1",
                    toolName = "Edit",
                    inputSummary = "src/config.ts (+12 -3)",
                    suggestions = listOf("y", "n"),
                    decidable = true,
                    receivedAt = t - 15_000,
                ) else null,
                stats = SessionStats(filesChanged = 3, linesAdded = 128, linesDeleted = 41),
                lastError = if (phase == 3) "TS2322: Type 'string' is not assignable" else null,
                doneReason = if (phase == 4) "completed" else null,
                durationMs = if (phase == 4) 180_000 else null,
            ),
            SessionState(
                sessionId = "demo-2",
                title = "编写 Wear 端协议",
                model = "glm-4.7",
                status = if (phase < 3) SessionStatus.WORKING else SessionStatus.WAITING,
                actionSummary = "读取 wear-app/Protocol.kt",
                startedAt = t - 95_000,
                updatedAt = t,
                waitingRequest = if (phase >= 3) WaitingRequest(
                    requestId = "req-2",
                    toolName = "Bash",
                    inputSummary = "gradlew assembleDebug",
                    decidable = true,
                    receivedAt = t - 5_000,
                ) else null,
                stats = SessionStats(filesChanged = 1, linesAdded = 56, linesDeleted = 2),
            ),
            SessionState(
                sessionId = "demo-3",
                title = "整理设计文档",
                status = SessionStatus.DONE,
                actionSummary = "已归档到 design/",
                startedAt = t - 3_600_000,
                updatedAt = t - 3_400_000,
                stats = SessionStats(filesChanged = 2, linesAdded = 90, linesDeleted = 0),
                durationMs = 200_000,
                doneReason = "completed",
            ),
        )
    }

    override fun sendCommand(cmd: WatchCommand) {
        // demo 模式下仅本地反馈：把 WAITING 会话转回 WORKING
        if (cmd is WatchCommand.Allow || cmd is WatchCommand.Reject || cmd is WatchCommand.Stop) {
            _sessions.value = _sessions.value.map {
                if (it.sessionId == cmd.sessionId && it.status == SessionStatus.WAITING)
                    it.copy(status = SessionStatus.WORKING, waitingRequest = null, actionSummary = "指令已发送（演示）")
                else it
            }
        }
    }

    private fun newId() = UUID.randomUUID().toString()
}
