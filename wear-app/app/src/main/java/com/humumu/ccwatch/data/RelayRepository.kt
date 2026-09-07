package com.humumu.ccwatch.data

import android.util.Log
import com.humumu.ccwatch.protocol.ProtocolCodec
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
import java.util.concurrent.TimeUnit

/**
 * 直连 Relay WebSocket 仓库（手表自联网通道；主通道已让位 #380 蓝牙中继）。
 * 事件折叠/状态机在共享的 ProtocolEngine；本类只管 ws 传输与重连。
 */
class RelayRepository(private val host: String, private val token: String) : SessionRepo {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(5, TimeUnit.SECONDS)
        .build()
    private val engine = ProtocolEngine()

    private val _connected = MutableStateFlow(false)
    override val connected: StateFlow<Boolean> = _connected.asStateFlow()
    override val sessions = engine.sessions
    override val timelines = engine.timelines

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
            // #373 /wan 云桥透传：明文帧需 hello 握手（relay 侧 wt- 设备据此推 SNAPSHOT/事件流）
            if (host.contains("/wan")) {
                webSocket.send("""{"t":"hello","last_seq":$lastSeq}""")
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            engine.handleText(text)
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
        // #373 /wan 透传：host 即完整 URL（自带 token/dev/to query），原样直连不拼 /ws
        if (host.contains("/wan")) return host
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

    override fun sendCommand(cmd: WatchCommand) {
        val w = ws ?: return
        val requestId = engine.waitingRequestIdOf(cmd.sessionId)
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
