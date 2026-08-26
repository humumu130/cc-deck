package com.humumu.ccwatch.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material.MaterialTheme
import com.humumu.ccwatch.protocol.SessionStatus

/**
 * 视觉 Token：结构色按《手表端 UI 原型与 AI 开发详细规范 v1.0》，
 * 四态色与手机端 theme.ts（cc light 风格）保持一致（2026-08-25 用户确认手机端为基准）。
 */
object C {
    val bg = Color(0xFF050608)
    val bgAlt = Color(0xFF080A0D)
    val surface = Color(0xFF11151B)
    val primary = Color(0xFF6F63FF)
    val working = Color(0xFFFFC53D)
    val waiting = Color(0xFFF0524F)
    val error = Color(0xFFFF7849)
    val done = Color(0xFF2BD98F)
    val offline = Color(0xFF9AA0A6)
    val textPrimary = Color(0xFFF4F5F7)
    val textSecondary = Color(0xFF9298A3)
    val faintLabel = Color(0xFF5A6472)
}

@Composable
fun CcWatchTheme(content: @Composable () -> Unit) {
    MaterialTheme(colors = MaterialTheme.colors.copy(primary = C.primary, background = C.bg)) {
        Box(Modifier.fillMaxSize().background(C.bg)) { content() }
    }
}

fun statusColor(s: SessionStatus) = when (s) {
    SessionStatus.WORKING -> C.working
    SessionStatus.WAITING -> C.waiting
    SessionStatus.ERROR -> C.error
    SessionStatus.DONE -> C.done
}

// 规范要求大写英文状态文字；中文短标签用于列表与菜单
fun statusLabelEn(s: SessionStatus) = when (s) {
    SessionStatus.WORKING -> "WORKING"
    SessionStatus.WAITING -> "WAITING"
    SessionStatus.ERROR -> "ERROR"
    SessionStatus.DONE -> "DONE"
}

fun statusLabelZh(s: SessionStatus) = when (s) {
    SessionStatus.WORKING -> "运行中"
    SessionStatus.WAITING -> "等待确认"
    SessionStatus.ERROR -> "错误"
    SessionStatus.DONE -> "已完成"
}

fun formatDuration(ms: Long): String {
    if (ms < 0) return "-"
    val total = ms / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%dh%02dm".format(h, m) else "%dm%02ds".format(m, s)
}

// 紧凑 token 数（9300 -> 9.3k, 1234567 -> 1.2M）
fun formatTokens(n: Long): String = when {
    n >= 1_000_000 -> "%.1fM".format(n / 1_000_000.0)
    n >= 1_000 -> "%.1fk".format(n / 1_000.0)
    else -> n.toString()
}

fun formatClock(ts: Long): String {
    val cal = java.util.Calendar.getInstance().apply { timeInMillis = ts }
    return "%02d:%02d".format(cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE))
}

/** Markdown 转纯文本（手表小屏不做富文本渲染，去掉标记符保留内容） */
fun plainMd(s: String): String = s
    // GFM 表格：分隔线行整行丢弃，数据行去边界竖线、单元格以 " · " 连接
    .replace(Regex("(?m)^\\s*\\|?[-:|\\s]+\\|[-:|\\s]*$"), "")
    .replace(Regex("(?m)^\\s*\\|"), "")
    .replace(Regex("(?m)\\|\\s*$"), "")
    .replace(Regex("\\s*\\|\\s*"), " · ")
    .replace(Regex("(?m)^#{1,4}\\s+"), "")
    .replace(Regex("(?m)^>\\s?"), "")
    .replace(Regex("(?m)^\\s*```.*$"), "")
    .replace(Regex("`([^`\n]+)`"), "$1")
    .replace(Regex("\\*\\*([^*\n]+)\\*\\*"), "$1")
    .replace(Regex("\\*([^*\n]+)\\*"), "$1")
    .replace(Regex("__([^_\n]+)__"), "$1")
    .replace(Regex("\\[([^]\n]+)\\]\\([^)\n]+\\)"), "$1")
    .replace(Regex("(?m)^\\s*([-*+]|\\d+[.)])\\s+"), "· ")
