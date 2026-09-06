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
import com.humumu.ccwatch.protocol.WatchCommand
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 直连 Relay WebSocket 仓库（无 GMS 手表的主通道，规范 §14）。
 * 事件折叠逻辑与 expo-app/src/store.ts onEvent 一致；断线退避重连，保留最后已知状态。
 */
class RelayRepository(private val host: String, private val token: String) : SessionRepo {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(5, TimeUnit.SECONDS)
        .build()

    private val lock = Any()
    private val sessionMap = LinkedHashMap<String, SessionState>()
    private val timelineMap = HashMap<String, MutableList<RecentEvent>>()

    private val _sessions = MutableStateFlow<List<SessionState>>(emptyList())
    override val sessions: StateFlow<List<SessionState>> = _sessions.asStateFlow()
    private val _connected = MutableStateFlow(false)
    override val connected: StateFlow<Boolean> = _connected.asStateFlow()
    private val _timelines = MutableStateFlow<Map<String, List<RecentEvent>>>(emptyMap())
    override val timelines: StateFlow<Map<String, List<RecentEvent>>> = _timelines.asStateFlow()

    private var ws: WebSocket? = null
    @Volatile private var closed = false
    @Volatile private var reconnectDelay = 1000L
    // 已收到的最大事件 seq：重连带 last_seq 增量补发（对齐 ws-server replay 语义）
    @Volatile private var lastSeq = 0L

    // 注意：必须在 init{connect()} 之前声明——Kotlin 属性按声明顺序初始化，
    // 曾经 listener 声明在 init 之后导致构造期 NPE（RELAY 模式进必闪退）
    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            reconnectDelay = 1000L
            _connected.value = true
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching { handleJson(text) }.onFailure { Log.w(TAG, "bad message: $text", it) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "ws failure: ${t.message}")
            _connected.value = false
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            _connected.value = false
            scheduleReconnect()
        }
    }

    init {
        connect()
    }

    private fun url(): String {
        val base = if (host.startsWith("ws://") || host.startsWith("wss://")) host else "ws://$host"
        val trimmed = base.trimEnd('/')
        return "$trimmed/ws?token=${java.net.URLEncoder.encode(token, "UTF-8")}" +
            (if (lastSeq > 0) "&last_seq=$lastSeq" else "")
    }

    private fun connect() {
        if (closed) return
        val req = Request.Builder().url(url()).build()
        ws = client.newWebSocket(req, listener)
    }

    private fun scheduleReconnect() {
        if (closed) return
        val d = reconnectDelay
        reconnectDelay = (d * 2).coerceAtMost(15000L)
        scope.launch {
            delay(d)
            connect()
        }
    }

    private fun handleJson(text: String) {
        val o = JSONObject(text)
        if (o.optString("type") == "COMMAND_ACK") {
            if (!o.optBoolean("ok", false)) Log.w(TAG, "command failed: $text")
            return
        }
        onEnvelope(o)
    }

    private fun onEnvelope(env: JSONObject) {
        val sq = env.optLong("seq", 0L)
        if (sq > lastSeq) lastSeq = sq
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
                        // 上下文水位：relay 携带时覆盖（与手机 store 的"present 即覆盖"口径一致）
                        contextUsage = if (p.has("context_usage") && !p.isNull("context_usage")) p.getLong("context_usage") else s.contextUsage,
                        contextLimit = if (p.has("context_limit") && !p.isNull("context_limit")) p.getLong("context_limit") else s.contextLimit,
                        todos = if (p.has("todos") && !p.isNull("todos")) ProtocolCodec.parseTodos(p) else s.todos,
                        cronTasks = if (p.has("cron_tasks") && !p.isNull("cron_tasks")) ProtocolCodec.parseCronTasks(p) else s.cronTasks,
                        // 子 Agent 工作状态：present 即覆盖（[] = 清空，与手机 store 口径一致）
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
                        sid,
                        RecentEvent(ts, "system", "完成: ${p.optString("terminal_reason")} · %.1fs".format((p.optLong("duration_ms") / 1000.0)))
                    )
                }
                publish()
            }
            "TASK_DONE" -> {
                // 任务完成汇报（#288）：事件 payload 的 remaining 是 TodoItem[]，取长度即剩余数
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

    private fun publish() {
        synchronized(lock) {
            _sessions.value = sessionMap.values.toList()
            _timelines.value = timelineMap.mapValues { it.value.toList() }
        }
    }

    override fun sendCommand(cmd: WatchCommand) {
        val w = ws ?: return
        val requestId = synchronized(lock) { sessionMap[cmd.sessionId]?.waitingRequest?.requestId }
        runCatching { w.send(ProtocolCodec.encodeRelayCommand(cmd, requestId)) }
            .onFailure { Log.e(TAG, "sendCommand failed", it) }
    }

    override fun close() {
        closed = true
        runCatching { ws?.close(1000, "bye") }
        scope.cancel()
        client.dispatcher.executorService.shutdown()
    }

    companion object {
        private const val TAG = "RelayRepo"
    }
}
