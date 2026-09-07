package com.humumu.ccwatch.data

import android.util.Log
import com.humumu.ccwatch.protocol.ProtocolCodec
import com.humumu.ccwatch.protocol.RecentEvent
import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.SessionStats
import com.humumu.ccwatch.protocol.SessionStatus
import com.humumu.ccwatch.protocol.TaskDoneReport
import com.humumu.ccwatch.protocol.Usage
import com.humumu.ccwatch.protocol.WaitingRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

/**
 * #380 协议引擎：手表 JSON 协议的解析与状态折叠（SNAPSHOT/事件流/TASK_DONE），
 * 与传输层解耦——RelayRepository（ws 直连）与 BluetoothRepository（经手机蓝牙中继）
 * 共用。事件折叠逻辑与 expo-app/src/store.ts onEvent 一致。
 */
class ProtocolEngine {

    private val lock = Any()
    private val sessionMap = LinkedHashMap<String, SessionState>()
    private val timelineMap = HashMap<String, MutableList<RecentEvent>>()

    private val _sessions = MutableStateFlow<List<SessionState>>(emptyList())
    val sessions: StateFlow<List<SessionState>> = _sessions.asStateFlow()
    private val _timelines = MutableStateFlow<Map<String, List<RecentEvent>>>(emptyMap())
    val timelines: StateFlow<Map<String, List<RecentEvent>>> = _timelines.asStateFlow()

    fun handleText(text: String) {
        runCatching { onText(text) }.onFailure { Log.w(TAG, "bad message: $text", it) }
    }

    private fun onText(text: String) {
        val o = JSONObject(text)
        if (o.optString("type") == "COMMAND_ACK") {
            if (!o.optBoolean("ok", false)) Log.w(TAG, "command failed: $text")
            return
        }
        onEnvelope(o)
    }

    private fun onEnvelope(env: JSONObject) {
        val sid = env.optString("session_id")
        val ts = env.optLong("ts", System.currentTimeMillis())
        when (env.optString("type")) {
            "SNAPSHOT" -> {
                synchronized(lock) {
                    sessionMap.clear()
                    timelineMap.clear()
                    val payload = env.getJSONObject("payload")
                    val arr = payload.getJSONArray("sessions")
                    for (i in 0 until arr.length()) {
                        val s = ProtocolCodec.parseSession(arr.getJSONObject(i))
                        sessionMap[s.sessionId] = s
                        val logs = payload.optJSONObject("logs")?.optJSONArray(s.sessionId) ?: org.json.JSONArray()
                        val list = ArrayList<RecentEvent>(logs.length())
                        for (j in 0 until logs.length()) {
                            val ev = ProtocolCodec.parseEvent(logs.getJSONObject(j))
                            // 思考过程不在手表小屏展示（手机端有开关）
                            if (ev.kind != "thinking") list.add(ev)
                        }
                        timelineMap[s.sessionId] = list
                    }
                }
                publish()
            }
            "SESSION_CREATED" -> {
                val p = env.getJSONObject("payload")
                synchronized(lock) {
                    val title = p.optString("title").ifEmpty { p.optString("initial_prompt").take(24) }
                    sessionMap[sid] = SessionState(
                        sessionId = sid,
                        cwd = p.optString("cwd").ifEmpty { null },
                        initialPrompt = p.optString("initial_prompt").ifEmpty { null },
                        title = title.ifEmpty { "未命名会话" },
                        model = p.optString("model").ifEmpty { null },
                        status = SessionStatus.WORKING,
                        actionSummary = "启动中",
                        startedAt = ts,
                        updatedAt = ts,
                        external = p.optBoolean("external", false),
                    )
                    timelineMap[sid] = mutableListOf(
                        RecentEvent(ts, "system", if (p.optBoolean("external")) "外部会话接入 (hooks)" else "会话创建")
                    )
                }
                publish()
            }
            "SESSION_UPDATED" -> {
                synchronized(lock) {
                    val s = sessionMap[sid] ?: return
                    val p = env.getJSONObject("payload")
                    sessionMap[sid] = s.copy(
                        status = runCatching { SessionStatus.valueOf(p.getString("status")) }.getOrElse { s.status },
                        actionSummary = if (p.has("action_summary") && !p.isNull("action_summary")) p.getString("action_summary") else null,
                        stats = p.optJSONObject("stats")?.let {
                            SessionStats(
                                it.optInt("files_changed", 0), it.optInt("lines_added", 0), it.optInt("lines_deleted", 0)
                            )
                        } ?: s.stats,
                        title = if (!p.isNull("title") && p.optString("title").isNotEmpty()) p.getString("title") else s.title,
                        usage = p.optJSONObject("usage")?.let {
                            Usage(
                                it.optLong("input_tokens", 0), it.optLong("output_tokens", 0),
                                it.optLong("cache_read_input_tokens", 0), it.optLong("cache_creation_input_tokens", 0),
                            )
                        } ?: s.usage,
                        contextUsage = if (p.has("context_usage") && !p.isNull("context_usage")) p.getLong("context_usage") else s.contextUsage,
                        contextLimit = if (p.has("context_limit") && !p.isNull("context_limit")) p.getLong("context_limit") else s.contextLimit,
                        todos = if (p.has("todos") && !p.isNull("todos")) ProtocolCodec.parseTodos(p) else s.todos,
                        cronTasks = if (p.has("cron_tasks") && !p.isNull("cron_tasks")) ProtocolCodec.parseCronTasks(p) else s.cronTasks,
                        subagents = if (p.has("subagents") && !p.isNull("subagents")) ProtocolCodec.parseSubagents(p) else s.subagents,
                        updatedAt = ts,
                    )
                }
                publish()
            }
            "SESSION_HEARTBEAT" -> {
                synchronized(lock) {
                    val s = sessionMap[sid] ?: return
                    sessionMap[sid] = s.copy(elapsedHint = env.getJSONObject("payload").optLong("elapsed_ms"))
                }
                publish()
            }
            "SESSION_WAITING" -> {
                synchronized(lock) {
                    val s = sessionMap[sid] ?: return
                    val p = env.getJSONObject("payload")
                    sessionMap[sid] = s.copy(
                        status = SessionStatus.WAITING,
                        waitingRequest = WaitingRequest(
                            requestId = p.getString("request_id"),
                            toolName = p.optString("tool_name"),
                            inputSummary = if (p.has("input_summary") && !p.isNull("input_summary")) p.getString("input_summary") else null,
                            questions = ProtocolCodec.parseQuestions(p),
                            decidable = if (p.has("decidable") && !p.isNull("decidable")) p.getBoolean("decidable") else null,
                            receivedAt = ts,
                        ),
                    )
                }
                publish()
            }
            "SESSION_WAITING_RESOLVED" -> {
                synchronized(lock) {
                    val s = sessionMap[sid] ?: return
                    sessionMap[sid] = s.copy(status = SessionStatus.WORKING, waitingRequest = null)
                    val p = env.getJSONObject("payload")
                    val d = p.optString("decision")
                    val dText = when (d) {
                        "allow" -> "已允许"
                        "deny" -> "已拒绝"
                        "answer" -> "已作答"
                        else -> "远程审批超时，回退本地"
                    }
                    pushEventLocked(sid, RecentEvent(ts, "system", dText + if (d == "timeout") "" else " (by ${p.optString("by")})"))
                }
                publish()
            }
            "SESSION_ERROR" -> {
                synchronized(lock) {
                    val s = sessionMap[sid] ?: return
                    val msg = env.getJSONObject("payload").optString("message")
                    sessionMap[sid] = s.copy(status = SessionStatus.ERROR, lastError = msg)
                    pushEventLocked(sid, RecentEvent(ts, "system", "错误: $msg"))
                }
                publish()
            }
            "SESSION_DONE" -> {
                synchronized(lock) {
                    val s = sessionMap[sid] ?: return
                    val p = env.getJSONObject("payload")
                    sessionMap[sid] = s.copy(
                        status = SessionStatus.DONE,
                        doneReason = p.optString("terminal_reason"),
                        durationMs = if (p.has("duration_ms") && !p.isNull("duration_ms")) p.getLong("duration_ms") else null,
                        stats = p.optJSONObject("stats")?.let {
                            SessionStats(
                                it.optInt("files_changed", 0), it.optInt("lines_added", 0), it.optInt("lines_deleted", 0)
                            )
                        } ?: s.stats,
                    )
                    pushEventLocked(
                        sid, RecentEvent(ts, "system", "完成: ${p.optString("terminal_reason")} · %.1fs".format((p.optLong("duration_ms") / 1000.0)))
                    )
                }
                publish()
            }
            "TASK_DONE" -> {
                synchronized(lock) {
                    val s = sessionMap[sid] ?: return
                    val p = env.getJSONObject("payload")
                    sessionMap[sid] = s.copy(
                        lastTaskDone = TaskDoneReport(
                            done = p.optJSONArray("done")?.let { a -> (0 until a.length()).map { a.optString(it) } }
                                ?: emptyList(),
                            remainingCount = p.optJSONArray("remaining")?.length() ?: 0,
                            ts = p.optLong("ts", ts),
                        ),
                    )
                }
                publish()
            }
            "SESSION_LOG" -> {
                synchronized(lock) {
                    pushEventLocked(sid, ProtocolCodec.parseEvent(env.getJSONObject("payload")).copy(ts = env.getJSONObject("payload").optLong("ts", ts)))
                }
                publish()
            }
            "SESSION_DELETED" -> {
                synchronized(lock) {
                    sessionMap.remove(sid)
                    timelineMap.remove(sid)
                }
                publish()
            }
        }
    }

    private fun pushEventLocked(sid: String, e: RecentEvent) {
        if (e.kind == "thinking") return // 思考过程不在手表小屏展示（手机端有开关）
        val list = timelineMap.getOrPut(sid) { mutableListOf() }
        val ev = e.copy(ts = if (e.ts == 0L) System.currentTimeMillis() else e.ts)
        // 同 id 流式块原地替换，避免时间线被增量刷屏
        if (ev.id != null) {
            val i = list.indexOfFirst { it.id == ev.id }
            if (i >= 0) {
                list[i] = ev
                return
            }
        }
        list.add(ev)
        while (list.size > 100) list.removeAt(0)
    }

    fun waitingRequestIdOf(sid: String): String? = synchronized(lock) { sessionMap[sid]?.waitingRequest?.requestId }

    private fun publish() {
        synchronized(lock) {
            _sessions.value = sessionMap.values.toList()
            _timelines.value = timelineMap.mapValues { it.value.toList() }
        }
    }

    companion object {
        private const val TAG = "ProtocolEngine"
    }
}
