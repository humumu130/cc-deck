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
  private var wakeLock: android.os.PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    ensureChannel(nm, FG_CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_MIN)
    val pi = launchIntent(this, 0)
    val notif = buildNotification(this, FG_CHANNEL_ID, FG_TITLE, "保持与 PC 的连接中", pi, ongoing = true)
    // #85（2026-09-21）FGS type：35+ 的 dataSync 有 6h 硬性时限（onTimeout 不停即
    // crash），且部分 ROM 对 dataSync 型冻结策略激进——换 specialUse（自有分发，
    // 无 Play 政策审查；PROPERTY_SPECIAL_USE_FGS_SUBTYPE 在 manifest 里声明用途）。
    // 34 以下不认识 specialUse：29-33 沿用 dataSync（无时限问题），更老不传 type
    when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
        startForeground(FG_NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
        startForeground(FG_NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else -> startForeground(FG_NOTIFICATION_ID, notif)
    }
    // #85 PARTIAL_WAKE_LOCK：息屏后保 CPU 不睡——JS 心跳（15s/拍）在深睡下定时器
    // 全停，WS 因无流量被 NAT/服务端掐断（用户实测后台几分钟即断）。与 FGS 互补：
    // FGS 防进程被杀，WakeLock 防 CPU 休眠；厂商层 freezer 冻结仍需电池豁免
    //（App 设置抽屉「后台保活」引导）。持有代价是耗电，属保活诉求的必要成本
    val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
    if (wakeLock?.isHeld != true) {
      wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "ccdeck:relay_fg").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
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

    // #364 真机彩点全灰：FGS 渠道 IMPORTANCE_MIN 下系统按单色模式渲染通知，
    // ForegroundColorSpan 被剥离——改用自带颜色的 emoji 圆点（🟡working/🔴waiting/
    // 🟠error/🟢done），零计数档不显示，同列表 statChips 语义
    // #370 title 由 App 侧传状态概览（展开态系统头部已显 App 名，自设 CC Deck 会双标题）
    Function("updateStats") { working: Int, waiting: Int, error: Int, done: Int, title: String ->
      val ctx = appContext.reactContext ?: return@Function
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      ensureChannel(nm, FG_CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_MIN)
      val parts = listOf(
        "🟡" to working,
        "🔴" to waiting,
        "🟠" to error,
        "🟢" to done,
      ).filter { it.second > 0 }
      // 尾部不再重复"共 N 会话"（title 第一行已含总数），只留彩点+数量
      val body = buildString {
        for ((dot, n) in parts) append(dot).append(n).append(" ")
      }.trimEnd()
      val notif = buildNotification(ctx, FG_CHANNEL_ID, title.ifBlank { FG_TITLE }, body, launchIntent(ctx, 0), ongoing = true)
      try {
        nm.notify(FG_NOTIFICATION_ID, notif)
      } catch (_: SecurityException) {}
    }

    // #60/#59 后台保活豁免查询：ColorOS 等国产 ROM 在 FGS 运行下仍以 cgroup freezer
    // 冻结进程（2026-09-19 实测 /proc/<pid>/cgroup: freezer:/frozen 而 FGS isForeground=true），
    // WS 静默死、本地通知发不出。加入电池优化豁免（doze 白名单）后实测保持 thaw + 连接不断。
    // isIgnoringBatteryOptimizations 即该豁免状态的权威查询（adb dumpsys deviceidle whitelist 同源）
    Function("batteryExempt") {
      val ctx = appContext.reactContext ?: return@Function false
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
      pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    // #85 拉起电池豁免入口，三级兜底（2026-09-21 用户实测 ColorOS 点「去优化」无反应：
    // 主对话框 activity 缺失/被吞，旧实现静默失败 → 豁免从未授上 → freezer 冻结无解）。
    // 返回实际打开的页面：dialog=确认对话框 / list=电池优化列表页 / details=应用详情页
    // / none=全失败——JS 侧据此给手动路径引导（expo Function DSL 用尾表达式返回值）
    Function("requestBatteryExempt") {
      val ctx = appContext.reactContext
      if (ctx == null) {
        "none"
      } else {
        val pkg = android.net.Uri.parse("package:" + ctx.packageName)
        fun tryStart(intent: Intent): Boolean {
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          return try { ctx.startActivity(intent); true } catch (_: Exception) { false }
        }
        // 主路径：AOSP 标准确认对话框（一键允许/拒绝）→ 列表页（所有 ROM 都有，
        // 用户找到 App 设「不允许优化」）→ 应用详情页（至少能到达本 App 设置）
        when {
          tryStart(Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)) -> "dialog"
          tryStart(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) -> "list"
          tryStart(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)) -> "details"
          else -> "none"
        }
      }
    }
  }
}
