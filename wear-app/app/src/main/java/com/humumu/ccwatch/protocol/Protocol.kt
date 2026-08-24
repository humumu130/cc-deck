package com.humumu.ccwatch.protocol

import org.json.JSONObject

/**
 * 手表 <-> 手机 协议契约（与 relay 的 TS 接口字段保持一致，snake_case）。
 *
 * 手机 -> 手表  MessageClient path = [PATH_SESSIONS]，payload = SessionState[] 全量快照 JSON
 * 手表 -> 手机  MessageClient path = [PATH_CMD]，payload = WatchCommand JSON
 */
object Paths {
    const val PATH_SESSIONS = "/ccr/sessions"
    const val PATH_CMD = "/ccr/cmd"
}

enum class SessionStatus { WORKING, WAITING, ERROR, DONE }

data class WaitingRequest(
    val requestId: String,
    val toolName: String,
    val inputSummary: String?,
    val suggestions: List<String> = emptyList(),
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
)

sealed class WatchCommand(val typeId: String) {
    abstract val commandId: String
    abstract val sessionId: String

    data class Allow(override val commandId: String, override val sessionId: String) :
        WatchCommand("COMMAND_ALLOW")

    data class Reject(override val commandId: String, override val sessionId: String) :
        WatchCommand("COMMAND_REJECT")

    data class Stop(override val commandId: String, override val sessionId: String) :
        WatchCommand("COMMAND_STOP")

    data class Message(
        override val commandId: String,
        override val sessionId: String,
        val text: String,
    ) : WatchCommand("COMMAND_MESSAGE")
}

object ProtocolCodec {
    private fun optLong(o: JSONObject, k: String): Long? = if (o.has(k) && !o.isNull(k)) o.getLong(k) else null
    private fun optStr(o: JSONObject, k: String): String? = if (o.has(k) && !o.isNull(k)) o.getString(k) else null

    fun parseSessions(json: String): List<SessionState> {
        val arr = org.json.JSONArray(json)
        return (0 until arr.length()).map { i -> parseSession(arr.getJSONObject(i)) }
    }

    private fun parseSession(o: JSONObject): SessionState {
        val w = o.optJSONObject("waiting_request")?.let { wj ->
            WaitingRequest(
                requestId = wj.getString("request_id"),
                toolName = wj.getString("tool_name"),
                inputSummary = optStr(wj, "input_summary"),
                suggestions = wj.optJSONArray("suggestions")?.let { s ->
                    (0 until s.length()).map { s.getString(it) }
                } ?: emptyList(),
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
        )
    }

    fun encodeCommand(cmd: WatchCommand): String {
        val o = JSONObject()
        o.put("command_id", cmd.commandId)
        o.put("type", cmd.typeId)
        o.put("session_id", cmd.sessionId)
        if (cmd is WatchCommand.Message) {
            o.put("payload", JSONObject().put("text", cmd.text))
        }
        return o.toString()
    }
}
