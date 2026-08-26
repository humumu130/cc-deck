package com.humumu.ccwatch.data

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.tasks.Tasks
import com.humumu.ccwatch.protocol.Paths
import com.humumu.ccwatch.protocol.ProtocolCodec
import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.WatchCommand
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.Executors

/**
 * 真实数据层仓库：仅通过 Wear Data Layer（MessageClient / NodeClient）与手机通信，
 * 绝不直连 Relay WebSocket。
 */
class DataLayerRepository(context: Context) : SessionRepo {

    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val messageClient: MessageClient = Wearable.getMessageClient(appContext)
    private val nodeClient = Wearable.getNodeClient(appContext)
    private val executor = Executors.newSingleThreadExecutor()

    private val _sessions = MutableStateFlow<List<SessionState>>(emptyList())
    override val sessions: StateFlow<List<SessionState>> = _sessions.asStateFlow()

    private val _connected = MutableStateFlow(false)
    override val connected: StateFlow<Boolean> = _connected.asStateFlow()

    /** GMS 快照通道不含日志；W2 活动强度降级为状态推导。 */
    override val timelines: StateFlow<Map<String, List<com.humumu.ccwatch.protocol.RecentEvent>>> =
        MutableStateFlow<Map<String, List<com.humumu.ccwatch.protocol.RecentEvent>>>(emptyMap()).asStateFlow()

    private val listener = MessageClient.OnMessageReceivedListener { event ->
        if (event.path != Paths.PATH_SESSIONS) return@OnMessageReceivedListener
        runCatching {
            val text = event.data.toString(Charsets.UTF_8)
            _sessions.value = ProtocolCodec.parseSessions(text)
            _connected.value = true
        }.onFailure { Log.e(TAG, "parse sessions failed", it) }
    }

    init {
        messageClient.addListener(listener)
        refreshConnected()
    }

    /** 查询当前已配对/连接的手机节点。 */
    fun refreshConnected() {
        scope.launch {
            runCatching {
                val nodes: List<Node> = Tasks.await(nodeClient.connectedNodes)
                _connected.value = nodes.any { it.isNearby }
            }.onFailure { Log.w(TAG, "connectedNodes failed", it) }
        }
    }

    override fun sendCommand(cmd: WatchCommand) {
        scope.launch {
            runCatching {
                val nodes: List<Node> = Tasks.await(nodeClient.connectedNodes)
                val payload = ProtocolCodec.encodeCommand(cmd).toByteArray(Charsets.UTF_8)
                nodes.filter { it.isNearby }.forEach { node ->
                    messageClient.sendMessage(node.id, Paths.PATH_CMD, payload)
                }
            }.onFailure { Log.e(TAG, "sendCommand failed", it) }
        }
    }

    override fun close() {
        runCatching { messageClient.removeListener(listener) }
    }

    companion object {
        private const val TAG = "DataLayerRepo"
    }
}
