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
const val ALERT_CHANNEL_ID = "relay_alert"
const val FG_NOTIFICATION_ID = 1
const val ALERT_NOTIFICATION_ID = 2

// 常驻前台服务：保活 WS 连接（用户也能从通知知晓后台运行）
class RelayForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(
        NotificationChannel(FG_CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_MIN)
      )
    }
    val pi = PendingIntent.getActivity(
      this, 0,
      packageManager.getLaunchIntentForPackage(packageName),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val notif = buildNotification(this, FG_CHANNEL_ID, "Cloud Code Relay", "保持与 PC 的连接中", pi, ongoing = true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(FG_NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(FG_NOTIFICATION_ID, notif)
    }
    return START_STICKY
  }
}

private fun buildNotification(ctx: Context, channelId: String, title: String, body: String, pi: PendingIntent?, ongoing: Boolean): Notification {
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

    // 高优先级提醒（WAITING 等确认）；无通知权限时静默跳过
    Function("notify") { title: String, body: String ->
      val ctx = appContext.reactContext ?: return@Function
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (!nm.areNotificationsEnabled()) return@Function
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        nm.createNotificationChannel(
          NotificationChannel(ALERT_CHANNEL_ID, "会话提醒", NotificationManager.IMPORTANCE_HIGH)
        )
      }
      val pi = PendingIntent.getActivity(
        ctx, 1,
        ctx.packageManager.getLaunchIntentForPackage(ctx.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val notif = buildNotification(ctx, ALERT_CHANNEL_ID, title, body, pi, ongoing = false)
      try {
        nm.notify(ALERT_NOTIFICATION_ID, notif)
      } catch (_: SecurityException) {}
    }
  }
}
