package expo.modules.wear

import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.tasks.Tasks
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Wear Data Layer 网关：手机侧收发（手表端契约见 wear-app protocol/Protocol.kt）。
// PATH_SESSIONS 下发全量会话快照 JSON；PATH_CMD 上行手表命令 JSON。
// 全部走 AsyncFunction：Tasks.await 在模块线程阻塞，不碰 JS 线程；
// 无 GMS 设备（如 Android-x86 VM）上所有调用静默返回空结果，不抛错。
class WearModule : Module() {
  private var listener: MessageClient.OnMessageReceivedListener? = null

  override fun definition() = ModuleDefinition {
    Name("Wear")

    Events("onMessage")

    OnDestroy {
      val ctx = appContext.reactContext
      val l = listener
      if (ctx != null && l != null) {
        runCatching { Wearable.getMessageClient(ctx).removeListener(l) }
      }
      listener = null
    }

    // 注册消息监听（幂等）；GMS 不可用返回 false
    AsyncFunction("start") {
      if (listener != null) return@AsyncFunction true
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      runCatching {
        val l = MessageClient.OnMessageReceivedListener { event ->
          val text = String(event.data, Charsets.UTF_8)
          sendEvent("onMessage", mapOf("path" to event.path, "text" to text))
        }
        Tasks.await(Wearable.getMessageClient(ctx).addListener(l))
        listener = l
        true
      }.getOrDefault(false)
    }

    // 已连接的可穿戴节点显示名（探测手表是否在场）
    AsyncFunction("getNodes") {
      val ctx = appContext.reactContext ?: return@AsyncFunction emptyList<String>()
      runCatching {
        Tasks.await(Wearable.getNodeClient(ctx).connectedNodes).map { it.displayName }
      }.getOrDefault(emptyList<String>())
    }

    // 向全部已连接节点发送文本消息，返回送达节点数
    AsyncFunction("send") { path: String, text: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction 0
      runCatching {
        val nodes = Tasks.await(Wearable.getNodeClient(ctx).connectedNodes)
        val data = text.toByteArray(Charsets.UTF_8)
        val client = Wearable.getMessageClient(ctx)
        for (node in nodes) client.sendMessage(node.id, path, data)
        nodes.size
      }.getOrDefault(0)
    }
  }
}
