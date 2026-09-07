package com.humumu.ccwatch.data

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.util.Log
import com.humumu.ccwatch.protocol.ProtocolCodec
import com.humumu.ccwatch.protocol.WatchCommand
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.util.UUID

/**
 * #380 蓝牙中继仓库（手表零配置主通道）：RFCOMM server 常开 listen，手机 App 侧
 * connect 进来即通——手机连什么（LAN/云桥）手表就有什么，手表自身不联网。
 * 帧协议：每行一个 JSON（与手机网关 /ccr/sessions、/ccr/cmd 同构：
 *   下行 = 会话数组 JSON 或事件帧 JSON；上行 = WatchCommand JSON）。
 * 无 GMS 依赖，标准蓝牙栈即可（需与手机配对 + BLUETOOTH_CONNECT 运行时权限）。
 */
class BluetoothRepository : SessionRepo {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val engine = ProtocolEngine()

    private val _connected = MutableStateFlow(false)
    override val connected: StateFlow<Boolean> = _connected.asStateFlow()
    override val sessions = engine.sessions
    override val timelines = engine.timelines

    @Volatile private var closed = false
    private val writeLock = Any()
    private var out: OutputStream? = null

    init {
        scope.launch { serveLoop() }
    }

    @SuppressLint("MissingPermission")
    private suspend fun serveLoop() {
        while (!closed) {
            var server: BluetoothServerSocket? = null
            try {
                val adapter = BluetoothAdapter.getDefaultAdapter()
                if (adapter == null) {
                    Log.w(TAG, "no bluetooth adapter")
                    delay(5000)
                    continue
                }
                server = adapter.listenUsingRfcommWithServiceRecord(SERVICE_NAME, SERVICE_UUID)
                Log.i(TAG, "rfcomm listening $SERVICE_UUID")
                while (!closed) {
                    val sock = server.accept() // 阻塞等手机连入
                    handleClient(sock)
                }
            } catch (e: SecurityException) {
                Log.w(TAG, "missing BLUETOOTH_CONNECT permission: ${e.message}")
                delay(3000)
            } catch (e: Exception) {
                Log.w(TAG, "serve loop: ${e.message}")
                delay(2000)
            } finally {
                runCatching { server?.close() }
            }
        }
    }

    private fun handleClient(sock: BluetoothSocket) {
        Log.i(TAG, "phone connected: ${sock.remoteDevice?.name}")
        var reader: BufferedReader? = null
        try {
            val input = sock.inputStream
            reader = BufferedReader(InputStreamReader(input, Charsets.UTF_8))
            synchronized(writeLock) { out = sock.outputStream }
            _connected.value = true
            while (!closed) {
                val line = reader.readLine() ?: break
                if (line.isBlank()) continue
                engine.handleText(line)
            }
        } catch (e: Exception) {
            Log.w(TAG, "client io: ${e.message}")
        } finally {
            runCatching { sock.close() }
            synchronized(writeLock) { out = null }
            _connected.value = false
            Log.i(TAG, "phone disconnected")
        }
    }

    override fun sendCommand(cmd: WatchCommand) {
        val payload = ProtocolCodec.encodeCommand(cmd).toByteArray(Charsets.UTF_8)
        scope.launch {
            val o = synchronized(writeLock) { out } ?: return@launch
            runCatching {
                synchronized(writeLock) {
                    o.write(payload)
                    o.write('\n'.code)
                    o.flush()
                }
            }.onFailure { Log.w(TAG, "send failed: ${it.message}") }
        }
    }

    override fun close() {
        closed = true
        scope.cancel()
    }

    companion object {
        private const val TAG = "BtRepo"
        private const val SERVICE_NAME = "CC Deck Link"
        /** 手机侧 WearLink 原生模块使用同一 UUID 连接 */
        val SERVICE_UUID: UUID = UUID.fromString("8e0c4a52-6d3e-4a9d-9f6b-2f1a55cc0d80")
    }
}
