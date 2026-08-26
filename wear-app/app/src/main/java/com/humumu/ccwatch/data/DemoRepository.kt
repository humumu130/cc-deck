package com.humumu.ccwatch.data

import com.humumu.ccwatch.protocol.RecentEvent
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

/** 演示仓库：3 个会话状态轮转 + 时间线事件流，无手机环境下演示 W1~W8 全部 UI。 */
class DemoRepository : SessionRepo {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val now get() = System.currentTimeMillis()
    /** 构造时刻：静态字段以此为准，避免每次 refresh 生成新实例触发无差别重组 */
    private val t0 = System.currentTimeMillis()

    private val _sessions = MutableStateFlow<List<SessionState>>(emptyList())
    override val sessions: StateFlow<List<SessionState>> = _sessions.asStateFlow()

    override val connected: StateFlow<Boolean> = MutableStateFlow(true)

    private val _timelines = MutableStateFlow<Map<String, List<RecentEvent>>>(emptyMap())
    override val timelines: StateFlow<Map<String, List<RecentEvent>>> = _timelines.asStateFlow()

    private var phase = 0
    private val tick = intArrayOf(0, 0, 0)

    init {
        refresh()
        scope.launch {
            while (isActive) {
                delay(2000)
                tick[0]++
                emitActivity()
                if (tick[0] % 2 == 0) {
                    phase = (phase + 1) % 5
                    refresh()
                }
            }
        }
    }

    private fun refresh() {
        _sessions.value = buildSessions()
        if (_timelines.value.isEmpty()) seedTimelines()
    }

    private val demoActions = listOf(
        "修改 src/auth.ts" to "Edit",
        "运行测试" to "Bash",
        "构建项目中..." to "Bash",
        "读取 store.ts" to "Read",
        "修改 src/user.ts" to "Edit",
    )

    private fun seedTimelines() {
        val t = now
        val map = mapOf(
            "demo-1" to listOf(
                RecentEvent(t - 480_000, "system", "会话创建"),
                RecentEvent(t - 420_000, "tool_use", "读取 package.json", "Read"),
                RecentEvent(t - 360_000, "tool_result", "48 行", "Read"),
                RecentEvent(t - 300_000, "tool_use", "修改 src/auth.ts", "Edit"),
                RecentEvent(t - 240_000, "assistant_text", "登录超时是因为 token 刷新失败，我来重构 auth 模块"),
            ),
            "demo-2" to listOf(
                RecentEvent(t - 90_000, "system", "会话创建"),
                RecentEvent(t - 60_000, "tool_use", "读取 wear-app/Protocol.kt", "Read"),
            ),
            "demo-3" to listOf(
                RecentEvent(t - 3_600_000, "system", "会话创建"),
                RecentEvent(t - 3_450_000, "system", "完成: completed · 200.0s"),
            ),
        )
        _timelines.value = map
    }

    /** WORKING 会话每 2s 追加一条事件，驱动 W2 时间线与 W1 活动强度点。 */
    private fun emitActivity() {
        val t = now
        val cur = _timelines.value.toMutableMap()
        _sessions.value.filter { it.status == SessionStatus.WORKING }.forEach { s ->
            val (text, tool) = demoActions[tick[0] % demoActions.size]
            val list = (cur[s.sessionId] ?: emptyList()) + RecentEvent(t, "tool_use", text, tool)
            cur[s.sessionId] = list.takeLast(100)
        }
        _timelines.value = cur
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
                    else -> "修改中：src/auth.ts"
                },
                startedAt = t - 200_000,
                updatedAt = t,
                elapsedHint = 200_000,
                waitingRequest = if (phase == 2) WaitingRequest(
                    requestId = "req-1",
                    toolName = "Edit",
                    inputSummary = "src/config.ts (+12 -3)",
                    suggestions = listOf("y", "n"),
                    decidable = true,
                    receivedAt = t - 15_000,
                ) else null,
                stats = SessionStats(filesChanged = 3, linesAdded = 128, linesDeleted = 41),
                lastError = if (phase == 3) "TS2322: Type 'string' is not assignable to 'number'" else null,
                doneReason = if (phase == 4) "completed" else null,
                durationMs = if (phase == 4) 180_000 else null,
            ),
            SessionState(
                sessionId = "demo-2",
                title = "编写 Wear 端协议",
                model = "glm-4.7",
                status = if (phase < 3) SessionStatus.WORKING else SessionStatus.WAITING,
                actionSummary = "读取中：wear-app/Protocol.kt",
                startedAt = t0 - 95_000,
                updatedAt = t0 - 95_000,
                elapsedHint = 95_000,
                waitingRequest = if (phase >= 3) WaitingRequest(
                    requestId = "req-2",
                    toolName = "Bash",
                    inputSummary = "gradlew assembleDebug",
                    decidable = true,
                    receivedAt = t0 - 5_000,
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
        // demo 模式本地反馈
        _sessions.value = _sessions.value.map {
            if (it.sessionId != cmd.sessionId) it
            else when (cmd) {
                is WatchCommand.Allow, is WatchCommand.Reject ->
                    if (it.status == SessionStatus.WAITING)
                        it.copy(status = SessionStatus.WORKING, waitingRequest = null, actionSummary = "指令已发送（演示）")
                    else it
                is WatchCommand.Stop ->
                    it.copy(status = SessionStatus.DONE, waitingRequest = null, actionSummary = "已停止（演示）", doneReason = "stopped", durationMs = now - it.startedAt)
                is WatchCommand.Message ->
                    it.copy(actionSummary = "已发送：${cmd.text.take(12)}")
                is WatchCommand.Delete -> it
            }
        }
        if (cmd is WatchCommand.Delete) {
            _sessions.value = _sessions.value.filter { it.sessionId != cmd.sessionId }
            _timelines.value = _timelines.value - cmd.sessionId
        }
    }
}
