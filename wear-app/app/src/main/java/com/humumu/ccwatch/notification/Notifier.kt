package com.humumu.ccwatch.notification

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.humumu.ccwatch.MainActivity
import com.humumu.ccwatch.R
import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.SessionStatus

/**
 * 状态通知 + 震动提醒（规范 §13：Waiting/Error 短震、Done 轻震；禁止持续震动）。
 * 三条独立渠道携带各自震动模式；W6 通知带 允许/拒绝 动作，抬腕即可处理。
 */
object Notifier {

    private const val CH_WAITING = "status_waiting"
    private const val CH_ERROR = "status_error"
    private const val CH_DONE = "status_done"

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        fun ch(id: String, name: String, pattern: LongArray, importance: Int) =
            NotificationChannel(id, name, importance).apply {
                enableVibration(true)
                vibrationPattern = pattern
                setSound(null, null) // 手表震动即提醒，不出声
            }
        nm.createNotificationChannel(ch(CH_WAITING, "等待确认", longArrayOf(0, 90, 90, 90), NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(ch(CH_ERROR, "错误", longArrayOf(0, 150, 120, 150), NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(ch(CH_DONE, "已完成", longArrayOf(0, 60), NotificationManager.IMPORTANCE_DEFAULT))
    }

    fun notify(ctx: Context, s: SessionState) {
        val (channel, title, text) = when (s.status) {
            SessionStatus.WAITING -> Triple(
                CH_WAITING,
                "等待确认 · ${s.title}",
                "「${s.waitingRequest?.toolName ?: "请求"}」${s.waitingRequest?.inputSummary ?: ""}",
            )
            SessionStatus.ERROR -> Triple(CH_ERROR, "出错 · ${s.title}", s.lastError ?: "未知错误")
            SessionStatus.DONE -> Triple(
                CH_DONE,
                "完成 · ${s.title}",
                "${s.stats.filesChanged} 文件 · ${(s.durationMs ?: 0L) / 1000}s",
            )
            SessionStatus.WORKING -> return
        }
        val open = PendingIntent.getActivity(
            ctx, s.sessionId.hashCode(),
            Intent(ctx, MainActivity::class.java).putExtra("sid", s.sessionId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = Notification.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
        if (s.status == SessionStatus.WAITING) {
            val rid = s.waitingRequest?.requestId
            b.addAction(action(ctx, "允许", "allow", s.sessionId, rid))
                .addAction(action(ctx, "拒绝", "deny", s.sessionId, rid))
        }
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(s.sessionId.hashCode(), b.build())
    }

    /** 任务完成汇报（#288 A 类⑥）：复用 CH_DONE 渠道（60ms 单次轻震，ColorOS 审核禁持续震动）。
     *  纯通知形态——手表无后台，前台时 W1 本就能看到 ☑ 进度；点按深链对应会话 W1。 */
    fun notifyTaskDone(ctx: Context, s: SessionState) {
        val td = s.lastTaskDone ?: return
        if (td.done.isEmpty()) return
        val n = td.done.size
        val tail = if (td.remainingCount > 0) "剩 ${td.remainingCount}" else "全部完成"
        val text = (if (n == 1) td.done.first() else "${td.done.first().take(24)} 等 $n 项") + " · $tail"
        val open = PendingIntent.getActivity(
            ctx, s.sessionId.hashCode(),
            Intent(ctx, MainActivity::class.java).putExtra("sid", s.sessionId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = Notification.Builder(ctx, CH_DONE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("完成任务 · ${s.title}")
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // 独立 id：回到 WORKING 撤状态通知时（notify/cancel 均按 sid.hashCode）不误清任务汇报
        nm.notify(("taskdone:" + s.sessionId).hashCode(), b.build())
    }

    private fun action(ctx: Context, label: String, kind: String, sid: String, rid: String?): Notification.Action {
        val pi = PendingIntent.getBroadcast(
            ctx, (sid + kind).hashCode(),
            Intent(ctx, NotificationActionReceiver::class.java)
                .putExtra("sid", sid).putExtra("kind", kind).putExtra("rid", rid),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Action.Builder(null, label, pi).build()
    }

    fun cancel(ctx: Context, sid: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(sid.hashCode())
    }
}
