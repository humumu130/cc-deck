package expo.modules.wearlink

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.UUID

/**
 * #380 WearLink：手机侧蓝牙 RFCOMM 客户端——与配对手表（wear-app
 * BluetoothRepository，同 SERVICE_UUID）建立行式 JSON 通道。手表零配置：
 * 手机连什么网络手表就有什么数据，手表侧不联网。
 * 协议：每行一个 JSON（下行 Envelope/快照，上行 WatchCommand）。
 */
class WearLinkModule : Module() {
  private var thread: Thread? = null
  @Volatile private var stopped = false
  private val writeLock = Any()
  private var out: java.io.OutputStream? = null

  override fun definition() = ModuleDefinition {
    Name("WearLink")
    Events("onMessage", "onStatus")

    OnDestroy { stop() }

    AsyncFunction("start") {
      if (thread?.isAlive == true) return@AsyncFunction true
      stopped = false
      if (!hasConnectPermission()) {
        // 首次弹出系统授权（S+ 运行时蓝牙权限）；watch.ts 会周期重试 start
        val act = appContext.currentActivity
        if (act != null) {
          act.requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN), 4280)
        }
        return@AsyncFunction false
      }
      thread = Thread { connectLoop() }.also { it.start() }
      true
    }

    Function("send") { text: String ->
      val o = synchronized(writeLock) { out } ?: return@Function false
      try {
        synchronized(writeLock) {
          o.write(text.toByteArray(Charsets.UTF_8))
          o.write('\n'.code)
          o.flush()
        }
        true
      } catch (e: Exception) {
        Log.w(TAG, "send failed: ${e.message}")
        false
      }
    }

    Function("stop") { stop() }
  }

  private fun hasConnectPermission(): Boolean {
    if (Build.VERSION.SDK_INT < 31) return true
    val ctx = appContext.reactContext ?: return false
    // CONNECT 管建连，SCAN 管 cancelDiscovery（缺 SCAN 时每次尝试都会被
    // SecurityException 打断，表现为永远连不上）——两者齐备才开循环
    return ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
      ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
  }

  private fun stop() {
    stopped = true
    runCatching { synchronized(writeLock) { out?.close() } }
    runCatching { thread?.interrupt() }
    thread = null
  }

  @SuppressLint("MissingPermission")
  private fun connectLoop() {
    while (!stopped) {
      val adapter = BluetoothAdapter.getDefaultAdapter()
      if (adapter == null || !adapter.isEnabled) {
        Log.i(TAG, "adapter off, wait")
        sendStatus(false, "蓝牙未开启")
        sleepQuiet(5000)
        continue
      }
      val devices: List<BluetoothDevice> = try { adapter.bondedDevices.toList() } catch (e: SecurityException) { Log.w(TAG, "bondedDevices: ${e.message}"); emptyList() }
      Log.i(TAG, "scan cycle: ${devices.size} bonded") // 诊断：确认循环活着与可见设备数
      var connectedSock: BluetoothSocket? = null
      for (d in devices) {
        if (stopped) return
        var sock: BluetoothSocket? = null
        try {
          adapter.cancelDiscovery()
          sock = d.createRfcommSocketToServiceRecord(SERVICE_UUID)
          sock.connect() // 阻塞；非手表设备会较快失败
          connectedSock = sock
          break
        } catch (e: Exception) {
          Log.i(TAG, "miss ${d.name}: ${e.message?.take(60)}") // 诊断：逐台失败原因
          runCatching { sock?.close() }
        }
      }
      if (connectedSock == null) {
        sendStatus(false, null)
        sleepQuiet(5000)
        continue
      }
      serve(connectedSock)
    }
  }

  private fun serve(sock: BluetoothSocket) {
    val name = try { sock.remoteDevice.name } catch (e: SecurityException) { "?" }
    Log.i(TAG, "watch connected: $name")
    var reader: BufferedReader? = null
    try {
      reader = BufferedReader(InputStreamReader(sock.inputStream, Charsets.UTF_8))
      synchronized(writeLock) { out = sock.outputStream }
      sendStatus(true, name)
      while (!stopped) {
        val line = reader.readLine() ?: break
        if (line.isBlank()) continue
        sendEvent("onMessage", mapOf("text" to line))
      }
    } catch (e: Exception) {
      Log.w(TAG, "serve: ${e.message}")
    } finally {
      runCatching { sock.close() }
      synchronized(writeLock) { out = null }
      sendStatus(false, null)
      Log.i(TAG, "watch disconnected")
    }
  }

  private fun sendStatus(connected: Boolean, name: String?) {
    try {
      sendEvent("onStatus", mapOf("connected" to connected, "name" to name))
    } catch (e: Exception) {
      Log.w(TAG, "sendStatus: ${e.message}")
    }
  }

  private fun sleepQuiet(ms: Long) {
    try { Thread.sleep(ms) } catch (e: InterruptedException) { Thread.currentThread().interrupt() }
  }

  companion object {
    private const val TAG = "WearLink"
    /** 与 wear-app BluetoothRepository.SERVICE_UUID 一致 */
    private val SERVICE_UUID: UUID = UUID.fromString("8e0c4a52-6d3e-4a9d-9f6b-2f1a55cc0d80")
  }
}
