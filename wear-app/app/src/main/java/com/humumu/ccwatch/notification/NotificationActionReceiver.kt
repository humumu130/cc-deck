package com.humumu.ccwatch.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.humumu.ccwatch.protocol.WatchCommand
import java.util.UUID

/** 通知栏一键 允许/拒绝 的命令总线：App 前台注册 sink，通知动作直接投递到当前仓库。 */
object CommandBus {
    @Volatile var sink: ((WatchCommand) -> Unit)? = null
}

class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val sid = intent.getStringExtra("sid") ?: return
        val rid = intent.getStringExtra("rid")
        val cmd = when (intent.getStringExtra("kind")) {
            "allow" -> WatchCommand.Allow(UUID.randomUUID().toString(), sid, rid)
            "deny" -> WatchCommand.Reject(UUID.randomUUID().toString(), sid, rid)
            else -> return
        }
        CommandBus.sink?.invoke(cmd)
        Notifier.cancel(context, sid)
    }
}
