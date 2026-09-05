package com.humumu.ccwatch.protocol

import org.json.JSONObject

/**
 * 协议契约（snake_case，与 relay 的 TS 定义一致）。
 *
 * 两种数据通道：
 * ① 手机网关（GMS Data Layer）：PATH_SESSIONS 全量快照 / PATH_CMD WatchCommand（顶层 session_id）
 * ② 直连 Relay WebSocket（OPPO 表无 GMS 的主通道）：Envelope 增量流 + relay 命令（payload 内 session_id）
 */
object Paths {
    const val PATH_SESSIONS = "/ccr/sessions"
    const val PATH_CMD = "/ccr/cmd"
}

enum class SessionStatus { WORKING, WAITING, ERROR, DONE }

/** AskUserQuestion 选项 */
data class AskOption(
    val label: String,
    val description: String? = null,
)

/** AskUserQuestion 问题（relay 清洗后） */
data class AskQuestion(
    val header: String,
    val question: String,
    val multi: Boolean = false,
    val options: List<AskOption> = emptyList(),
)

data class WaitingRequest(
    val requestId: String,
    val toolName: String,
    val inputSummary: String?,
    val suggestions: List<String> = emptyList(),
    val questions: List<AskQuestion> = emptyList(),
    val decidable: Boolean? = null,
    val receivedAt: Long? = null,
)

data class SessionStats(
    val filesChanged: Int = 0,
    val linesAdded: Int = 0,
    val linesDeleted: Int = 0,
)

data class Usage(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadInputTokens: Long = 0,
    val cacheCreationInputTokens: Long = 0,
)

data class SessionState(
    val sessionId: String,
    val relaySessionId: String? = null,
    val cwd: String? = null,
    val initialPrompt: String? = null,
    val title: String,
    val model: String? = null,
    val status: SessionStatus,
    val actionSummary: String? = null,
    val startedAt: Long,
    val updatedAt: Long,
    val waitingRequest: WaitingRequest? = null,
    val stats: SessionStats = SessionStats(),
    val lastError: String? = null,
    val doneReason: String? = null,
    val durationMs: Long? = null,
    val external: Boolean? = null,
    val usage: Usage? = null,
    val todos: List<TodoItem> = emptyList(),
    val cronTasks: List<CronTask> = emptyList(),
    val elapsedHint: Long? = null,
)

/** TodoWrite 任务项（activeForm 进行时描述优先展示） */
data class TodoItem(
    val id: Int = 0, // CLI 任务库任务号（转录 #NNN 定位用；旧 TodoWrite 清单为 0）
    val content: String,
    val status: String, // pending | in_progress | completed
    val activeForm: String? = null,
) {
    val isDone: Boolean get() = status == "completed"
    val label: String get() = activeForm?.takeIf { it.isNotBlank() } ?: content
}

/** 定时任务快照（会话目录 .claude/scheduled_tasks.json，relay 30s 轮询下发） */
data class CronTask(
    val id: String,
    val name: String,
    val prompt: String,
    val schedule: String,
    val nextRunAt: Long? = null,
    val paused: Boolean? = null,
    val recurring: Boolean? = null, // false = 一次性
)

/** 时间线事件（relay SESSION_LOG 的 LogEntry，W2 展示 + W1 活动强度推导） */
data class RecentEvent(
    val ts: Long,
    val kind: String, // assistant_text | tool_use | tool_result | system | user_message
    val text: String,
    val tool: String? = null,
    val full: String? = null, // 原文（relay 仅在 text 被截断时携带）
    val id: String? = null, // 流式块 id：同 id 事件在时间线原地替换
    val streaming: Boolean = false, // true = 该文本块仍在生成中
) {
    val isError: Boolean get() = kind == "system" && text.startsWith("错误")
    val isDone: Boolean get() = kind == "system" && text.startsWith("完成")
}

sealed class WatchCommand(val typeId: String) {
    abstract val commandId: String
    abstract val sessionId: String

    /** GMS 网关路径沿用 COMMAND_ALLOW（手机翻译为 CONTINUE）；relay 路径映射 COMMAND_CONTINUE */
    data class Allow(
        override val commandId: String,
        override val sessionId: String,
        val requestId: String? = null,
    ) : WatchCommand("COMMAND_ALLOW")

    data class Reject(
        override val commandId: String,
        override val sessionId: String,
        val requestId: String? = null,
        val reason: String? = null,
    ) : WatchCommand("COMMAND_REJECT")

    data class Stop(override val commandId: String, override val sessionId: String) :
        WatchCommand("COMMAND_STOP")

    data class Message(
        override val commandId: String,
        override val sessionId: String,
        val text: String,
    ) : WatchCommand("COMMAND_MESSAGE")

    /** AskUserQuestion 作答：answers[i] 对应 questions[i]（选项 label） */
    data class Answer(
        override val commandId: String,
        override val sessionId: String,
        val requestId: String? = null,
        val answers: List<String> = emptyList(),
    ) : WatchCommand("COMMAND_ANSWER")

    data class Delete(override val commandId: String, override val sessionId: String) :
        WatchCommand("COMMAND_DELETE")
}

object ProtocolCodec {
    private fun optLong(o: JSONObject, k: String): Long? = if (o.has(k) && !o.isNull(k)) o.getLong(k) else null
    private fun optStr(o: JSONObject, k: String): String? = if (o.has(k) && !o.isNull(k)) o.getString(k) else null

    /** SessionState.todos / SESSION_UPDATED.payload.todos 通用解析 */
    fun parseTodos(o: JSONObject): List<TodoItem> =
        o.optJSONArray("todos")?.let { arr ->
            (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.takeIf { tj -> tj.optString("content").isNotBlank() }?.let { tj ->
                    TodoItem(
                        id = tj.optInt("id", 0),
                        content = tj.optString("content"),
                        status = tj.optString("status", "pending"),
                        activeForm = if (tj.has("active_form") && !tj.isNull("active_form")) tj.getString("active_form") else null,
                    )
                }
            }
        } ?: emptyList()

    /** SessionState.cron_tasks / SESSION_UPDATED.payload.cron_tasks 通用解析 */
    fun parseCronTasks(o: JSONObject): List<CronTask> =
        o.optJSONArray("cron_tasks")?.let { arr ->
            (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.takeIf { tj -> tj.optString("id").isNotBlank() }?.let { tj ->
                    CronTask(
                        id = tj.optString("id"),
                        name = tj.optString("name"),
                        prompt = tj.optString("prompt"),
                        schedule = tj.optString("schedule"),
                        nextRunAt = optLong(tj, "next_run_at"),
                        paused = if (tj.has("paused") && !tj.isNull("paused")) tj.getBoolean("paused") else null,
                        recurring = if (tj.has("recurring") && !tj.isNull("recurring")) tj.getBoolean("recurring") else null,
                    )
                }
            }
        } ?: emptyList()

    fun parseSessions(json: String): List<SessionState> {
        val arr = org.json.JSONArray(json)
        return (0 until arr.length()).map { i -> parseSession(arr.getJSONObject(i)) }
    }

    /** WaitingPayload.questions 解析（SNAPSHOT 与 SESSION_WAITING 共用） */
    fun parseQuestions(wj: JSONObject): List<AskQuestion> =
        wj.optJSONArray("questions")?.let { arr ->
            (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.takeIf { qj -> qj.optString("question").isNotBlank() }?.let { qj ->
                    AskQuestion(
                        header = qj.optString("header").ifEmpty { qj.optString("question").take(24) },
                        question = qj.optString("question"),
                        multi = qj.optBoolean("multi", false),
                        options = qj.optJSONArray("options")?.let { o ->
                            (0 until o.length()).mapNotNull { k ->
                                o.optJSONObject(k)?.takeIf { oj -> oj.optString("label").isNotBlank() }?.let { oj ->
                                    AskOption(
                                        label = oj.optString("label"),
                                        description = optStr(oj, "description"),
                                    )
                                }
                            }
                        } ?: emptyList(),
                    )
                }
            }
        } ?: emptyList()

    fun parseSession(o: JSONObject): SessionState {
        val w = o.optJSONObject("waiting_request")?.let { wj ->
            WaitingRequest(
                requestId = wj.getString("request_id"),
                toolName = wj.getString("tool_name"),
                inputSummary = optStr(wj, "input_summary"),
                suggestions = wj.optJSONArray("suggestions")?.let { s ->
                    (0 until s.length()).map { s.getString(it) }
                } ?: emptyList(),
                questions = parseQuestions(wj),
                decidable = if (wj.has("decidable") && !wj.isNull("decidable")) wj.getBoolean("decidable") else null,
                receivedAt = optLong(wj, "received_at"),
            )
        }
        val st = o.optJSONObject("stats")?.let { s ->
            SessionStats(
                filesChanged = s.optInt("files_changed", 0),
                linesAdded = s.optInt("lines_added", 0),
                linesDeleted = s.optInt("lines_deleted", 0),
            )
        } ?: SessionStats()
        val usage = o.optJSONObject("usage")?.let { u ->
            Usage(
                inputTokens = u.optLong("input_tokens", 0),
                outputTokens = u.optLong("output_tokens", 0),
                cacheReadInputTokens = u.optLong("cache_read_input_tokens", 0),
                cacheCreationInputTokens = u.optLong("cache_creation_input_tokens", 0),
            )
        }
        return SessionState(
            sessionId = o.getString("session_id"),
            relaySessionId = optStr(o, "relay_session_id"),
            cwd = optStr(o, "cwd"),
            initialPrompt = optStr(o, "initial_prompt"),
            title = optStr(o, "title") ?: "未命名会话",
            model = optStr(o, "model"),
            status = runCatching { SessionStatus.valueOf(o.getString("status")) }.getOrDefault(SessionStatus.WORKING),
            actionSummary = optStr(o, "action_summary"),
            startedAt = optLong(o, "started_at") ?: 0L,
            updatedAt = optLong(o, "updated_at") ?: 0L,
            waitingRequest = w,
            stats = st,
            lastError = optStr(o, "last_error"),
            doneReason = optStr(o, "done_reason"),
            durationMs = optLong(o, "duration_ms"),
            external = if (o.has("external") && !o.isNull("external")) o.getBoolean("external") else null,
            usage = usage,
            todos = parseTodos(o),
            cronTasks = parseCronTasks(o),
            elapsedHint = optLong(o, "elapsed_hint"),
        )
    }

    fun parseEvent(o: JSONObject): RecentEvent = RecentEvent(
        ts = optLong(o, "ts") ?: 0L,
        kind = optStr(o, "kind") ?: "system",
        text = optStr(o, "text") ?: "",
        tool = optStr(o, "tool"),
        full = optStr(o, "full"),
        id = optStr(o, "id"),
        streaming = o.optBoolean("streaming", false),
    )

    /** 手机网关（GMS Data Layer）命令编码：顶层 session_id，由 expo-app watch.ts 翻译。 */
    fun encodeCommand(cmd: WatchCommand): String {
        val o = JSONObject()
        o.put("command_id", cmd.commandId)
        o.put("type", cmd.typeId)
        o.put("session_id", cmd.sessionId)
        if (cmd is WatchCommand.Message) {
            o.put("payload", JSONObject().put("text", cmd.text))
        }
        if (cmd is WatchCommand.Answer) {
            o.put("payload", JSONObject()
                .put("request_id", cmd.requestId ?: JSONObject.NULL)
                .put("answers", org.json.JSONArray(cmd.answers)))
        }
        return o.toString()
    }

    /**
     * 直连 Relay 命令编码（session-manager.ts 约定：session_id / request_id / text 都在 payload 内）。
     * [fallbackRequestId] 由仓库在发送时从当前 waiting_request 解析补齐。
     */
    fun encodeRelayCommand(cmd: WatchCommand, fallbackRequestId: String? = null): String {
        val type = when (cmd) {
            is WatchCommand.Allow -> "COMMAND_CONTINUE"
            else -> cmd.typeId
        }
        val payload = JSONObject().put("session_id", cmd.sessionId)
        when (cmd) {
            is WatchCommand.Allow -> payload.put("request_id", cmd.requestId ?: fallbackRequestId)
            is WatchCommand.Reject -> {
                payload.put("request_id", cmd.requestId ?: fallbackRequestId)
                cmd.reason?.let { payload.put("reason", it) }
            }
            is WatchCommand.Message -> payload.put("text", cmd.text)
            is WatchCommand.Answer -> {
                payload.put("request_id", cmd.requestId ?: fallbackRequestId)
                payload.put("answers", org.json.JSONArray(cmd.answers))
            }
            else -> {}
        }
        val o = JSONObject()
        o.put("command_id", cmd.commandId)
        o.put("type", type)
        o.put("payload", payload)
        o.put("ts", System.currentTimeMillis())
        return o.toString()
    }
}
