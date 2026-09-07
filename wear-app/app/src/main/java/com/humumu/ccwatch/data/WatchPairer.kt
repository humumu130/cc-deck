package com.humumu.ccwatch.data

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
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
 * #316 手表免配置接入：mDNS 发现（_ccdeck._tcp，relay 侧 bonjour 广播）→
 * 待配对信道 /ws?pair=1 → 手表屏显示 relay 下发的 6 位码，手机核对后授权 →
 * PAIR_OK 携带 token，经 onSave 落库即完成（MainActivity 重建仓库自动直连）。
 * BT 网络共享时组播不过 NAT——首次配对手表需连 WiFi（日常使用不受影响）。
 */
sealed class PairState {
    data object Discovering : PairState()
    data class ShowCode(val hostPort: String, val code: String) : PairState()
    data class Fail(val reason: String) : PairState()
}

class WatchPairer(private val context: Context) {

    var onGranted: ((hostPort: String, token: String) -> Unit)? = null

    private val _state = MutableStateFlow<PairState>(PairState.Discovering)
    val state: StateFlow<PairState> = _state.asStateFlow()

    private var nsd: NsdManager? = null
    private var listener: NsdManager.DiscoveryListener? = null
    private var ws: WebSocket? = null
    private var timeout: android.os.Handler? = null
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .build()

    fun start() {
        val nsdManager = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
        if (nsdManager == null) {
            _state.value = PairState.Fail("此手表不支持网络发现，请手动输入")
            return
        }
        nsd = nsdManager
        // 发现超时：resolve 卡死/组播被路由器拦时不能永远停在"发现中"
        val h = android.os.Handler(android.os.Looper.getMainLooper())
        timeout = h
        h.postDelayed({
            if (_state.value is PairState.Discovering) {
                _state.value = PairState.Fail("未发现 PC：确认手表与 PC 同一 WiFi")
            }
        }, 15_000L)
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                _state.value = PairState.Fail("发现失败：确认与 PC 同一 WiFi 后重试")
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (listener == null) return // 已停止（配对完成/放弃）
                // 自家 LAN 一般只有一台 relay：发现即解析
                nsdManager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                        if (listener == null) return
                        _state.value = PairState.Fail("解析 PC 地址失败，请重试")
                    }
                    override fun onServiceResolved(info: NsdServiceInfo) {
                        if (listener == null) return // 迟到回调：UI 已关，别再开孤儿连接
                        val host = info.host?.hostAddress ?: return
                        connectPair("$host:${info.port}")
                    }
                })
            }
        }
        listener = l
        runCatching { nsdManager.discoverServices("_ccdeck._tcp.", NsdManager.PROTOCOL_DNS_SD, l) }
            .onFailure { _state.value = PairState.Fail("发现失败：请手动输入地址") }
    }

    private fun connectPair(hostPort: String) {
        if (ws != null) return // 已有配对连接在跑
        val name = Build.MODEL.ifBlank { "手表" }
        val req = Request.Builder()
            .url("ws://$hostPort/ws?pair=1&name=${java.net.URLEncoder.encode(name, "UTF-8")}")
            .build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {}
            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    val o = JSONObject(text)
                    when (o.optString("type")) {
                        "PAIR_PENDING" -> _state.value = PairState.ShowCode(hostPort, o.optString("code"))
                        "PAIR_OK" -> onGranted?.invoke(hostPort, o.optString("token"))
                        "PAIR_DENY" -> _state.value =
                            PairState.Fail(if (o.has("reason")) o.optString("reason") else "已在手机上拒绝")
                        "PAIR_TIMEOUT" -> _state.value = PairState.Fail("超时未授权，请重试")
                    }
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (_state.value is PairState.ShowCode || _state.value is PairState.Fail) return
                _state.value = PairState.Fail("连不上 $hostPort：${t.message}")
            }
        })
    }

    fun close() {
        runCatching { listener?.let { nsd?.stopServiceDiscovery(it) } }
        listener = null
        runCatching { timeout?.removeCallbacksAndMessages(null) }
        timeout = null
        runCatching { ws?.cancel() }
        ws = null
    }
}
