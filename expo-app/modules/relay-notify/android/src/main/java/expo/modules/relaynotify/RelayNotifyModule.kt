package expo.modules.relaynotify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

const val FG_CHANNEL_ID = "relay_fg"
// #349：渠道重要性在创建时锁定（同 id 重建改不动）——早期版本若以低级别建过
// relay_alert，heads-up 永远不弹。换新 id 并删旧渠道；IMPORTANCE_HIGH 才有横幅直弹
const val ALERT_CHANNEL_ID = "relay_alert_hu"
const val LEGACY_ALERT_CHANNEL_ID = "relay_alert"
const val FG_NOTIFICATION_ID = 1
const val ALERT_NOTIFICATION_ID = 2
const val FG_TITLE = "CC Deck" // #301 品牌统一（原 "Cloud Code Relay"）

// 常驻前台服务：保活 WS 连接（用户也能从通知知晓后台运行）
class RelayForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    ensureChannel(nm, FG_CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_MIN)
    val pi = launchIntent(this, 0)
    val notif = buildNotification(this, FG_CHANNEL_ID, FG_TITLE, "保持与 PC 的连接中", pi, ongoing = true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(FG_NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(FG_NOTIFICATION_ID, notif)
    }
    return START_STICKY
  }
}

// 渠道创建幂等（已存在同名同重要性的渠道为 no-op）
private fun ensureChannel(nm: NotificationManager, id: String, name: String, importance: Int) {
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    nm.createNotificationChannel(NotificationChannel(id, name, importance))
  }
}

// 回到 App 的点击意图（requestCode 区分前台/提醒两处 PendingIntent）
private fun launchIntent(ctx: Context, requestCode: Int): PendingIntent? {
  return PendingIntent.getActivity(
    ctx, requestCode,
    ctx.packageManager.getLaunchIntentForPackage(ctx.packageName),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
  )
}

private fun buildNotification(ctx: Context, channelId: String, title: String, body: CharSequence, pi: PendingIntent?, ongoing: Boolean): Notification {
  val icon = ctx.applicationInfo.icon
  return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    Notification.Builder(ctx, channelId)
      .setContentTitle(title).setContentText(body).setSmallIcon(icon)
      .setContentIntent(pi).setOngoing(ongoing).setAutoCancel(!ongoing)
      .build()
  } else {
    @Suppress("DEPRECATION")
    Notification.Builder(ctx)
      .setContentTitle(title).setContentText(body).setSmallIcon(icon)
      .setContentIntent(pi).setOngoing(ongoing).setAutoCancel(!ongoing)
      // #349 pre-O：heads-up 走 notification priority（O+ 由渠道重要性决定）
      .setPriority(if (ongoing) Notification.PRIORITY_MIN else Notification.PRIORITY_HIGH)
      .build()
  }
}

class RelayNotifyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RelayNotify")

    Function("start") {
      val ctx = appContext.reactContext ?: return@Function false
      val intent = Intent(ctx, RelayForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
      true
    }

    Function("stop") {
      val ctx = appContext.reactContext ?: return@Function false
      ctx.stopService(Intent(ctx, RelayForegroundService::class.java))
      true
    }

    // 高优先级提醒（WAITING 等确认/任务完成）；无通知权限时静默跳过
    Function("notify") { title: String, body: String ->
      val ctx = appContext.reactContext ?: return@Function
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (!nm.areNotificationsEnabled()) return@Function
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        nm.deleteNotificationChannel(LEGACY_ALERT_CHANNEL_ID) // #349 清掉低级别旧渠道
      }
      ensureChannel(nm, ALERT_CHANNEL_ID, "会话提醒", NotificationManager.IMPORTANCE_HIGH)
      val notif = buildNotification(ctx, ALERT_CHANNEL_ID, title, body, launchIntent(ctx, 1), ongoing = false)
      try {
        nm.notify(ALERT_NOTIFICATION_ID, notif)
      } catch (_: SecurityException) {}
    }

    // #301/#355 更新前台服务通知正文（App 侧按会话/连接态刷新）：同 channel/id 重建
    // Notification 覆盖常驻通知。#355 stats 版用彩色灯点+数字（working 琥珀/waiting 红/
    // error 橙/done 绿，同列表 statChips 语言）——SpannableString 着色，纯文本通知做不到
    Function("update") { text: String ->
      val ctx = appContext.reactContext ?: return@Function
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      ensureChannel(nm, FG_CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_MIN)
      val notif = buildNotification(ctx, FG_CHANNEL_ID, FG_TITLE, text, launchIntent(ctx, 0), ongoing = true)
      try {
        nm.notify(FG_NOTIFICATION_ID, notif)
      } catch (_: SecurityException) {}
    }

    Function("updateStats") { working: Int, waiting: Int, error: Int, done: Int ->
      val ctx = appContext.reactContext ?: return@Function
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      ensureChannel(nm, FG_CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_MIN)
      val span = android.text.SpannableStringBuilder()
      val parts = listOf(
        "●" to working to 0xFFFFC53D.toInt(), // working 琥珀
        "●" to waiting to 0xFFF0524F.toInt(), // waiting 红
        "●" to error to 0xFFFF7849.toInt(),   // error 橙
        "●" to done to 0xFF2BD98F.toInt(),    // done 绿
      )
      for ((pair, col) in parts) {
        val (dot, n) = pair
        val start = span.length
        span.append(dot).append(n.toString()).append("  ")
        span.setSpan(android.text.style.ForegroundColorSpan(col), start, start + 1, android.text.Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
      val total = working + waiting + error + done
      span.append("共 $total 会话")
      val notif = buildNotification(ctx, FG_CHANNEL_ID, FG_TITLE, span, launchIntent(ctx, 0), ongoing = true)
      try {
        nm.notify(FG_NOTIFICATION_ID, notif)
      } catch (_: SecurityException) {}
    }
  }
}
