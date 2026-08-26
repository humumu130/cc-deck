package com.humumu.ccwatch.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import com.humumu.ccwatch.protocol.AskQuestion
import com.humumu.ccwatch.protocol.RecentEvent
import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.SessionStatus
import com.humumu.ccwatch.protocol.WaitingRequest
import com.humumu.ccwatch.protocol.WatchCommand
import java.util.UUID

/**
 * W1 · 当前 Session 首页卡片（规范 §5），按状态呈现 W6/W7/W8 变体（规范 §11/§12）。
 * 抬腕 1~2 秒回答"哪个 Session 在运行、是否需要我处理"。
 */
@Composable
fun W1Card(
    s: SessionState,
    events: List<RecentEvent>,
    onCommand: (WatchCommand) -> Unit,
    onOpenTimeline: () -> Unit,
) {
    val cid = { UUID.randomUUID().toString() }
    // 状态色辐射光晕：贴圆形表盘的"表盘感"，OLED 上只点亮中心区域
    val halo = remember(s.status) {
        Brush.radialGradient(
            listOf(statusColor(s.status).copy(alpha = 0.11f), C.bg.copy(alpha = 0f)),
        )
    }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = Modifier
            .fillMaxSize()
            .background(halo)
            .padding(horizontal = 20.dp),
    ) {
        StatusBadge(s.status, iconSize = 18.dp, fontSize = 12)
        Spacer(Modifier.height(6.dp))
        Text(
            s.title,
            color = C.textPrimary,
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
        when (s.status) {
            SessionStatus.WAITING -> WaitingBody(s, onCommand, cid)
            SessionStatus.ERROR -> ErrorBody(s, onCommand, cid, onOpenTimeline)
            SessionStatus.DONE -> DoneBody(s)
            SessionStatus.WORKING -> WorkingBody(s, events)
        }
    }
}

@Composable
private fun WorkingBody(s: SessionState, events: List<RecentEvent>) {
    s.actionSummary?.let {
        Spacer(Modifier.height(4.dp))
        Text(
            it,
            color = C.textSecondary,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
    // 当前任务：首个进行中项（activeForm 优先），与动作摘要互补——摘要是"正在敲什么"，任务是"整体走到哪步"
    s.todos.firstOrNull { !it.isDone && it.status == "in_progress" }?.let { t ->
        Spacer(Modifier.height(3.dp))
        Text(
            "▸ ${t.label}",
            color = C.working,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
    Spacer(Modifier.height(10.dp))
    ActivityDots(activityIntensity(events, s), statusColor(s.status))
    Spacer(Modifier.height(10.dp))
    StatsRow(s)
    WorkingMetaRow(s)
}

/** 运行中元信息：耗时 · 输出 tokens · 任务进度（快照间隔内静态，不逐秒跳动） */
@Composable
private fun WorkingMetaRow(s: SessionState) {
    val todos = s.todos
    val done = todos.count { it.isDone }
    val tok = s.usage?.outputTokens ?: 0L
    val text = buildList {
        add(formatDuration(System.currentTimeMillis() - s.startedAt))
        if (tok > 0) add("↓${formatTokens(tok)}")
        if (todos.isNotEmpty()) add("☑$done/${todos.size}")
    }.joinToString(" · ")
    Spacer(Modifier.height(4.dp))
    Text(
        text,
        color = C.textSecondary,
        fontSize = 10.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
    )
}

/** W6 · Waiting 确认：明确写出需要用户做什么 + Allow/Reject 同屏（规范 §11）。
 *  AskUserQuestion 变体：问题 + 选项点选作答（多问顺序推进，点完自动发送）。 */
@Composable
private fun WaitingBody(s: SessionState, onCommand: (WatchCommand) -> Unit, cid: () -> String) {
    val w = s.waitingRequest
    val qs = w?.questions ?: emptyList()
    if (qs.isNotEmpty()) {
        AskBody(s, w, qs, onCommand, cid)
        return
    }
    Spacer(Modifier.height(6.dp))
    Text(
        w?.let { "「${it.toolName}」请求确认" } ?: "需要确认",
        color = C.waiting,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
    w?.inputSummary?.let {
        Spacer(Modifier.height(3.dp))
        Text(
            it,
            color = C.textSecondary,
            fontSize = 11.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
    Spacer(Modifier.height(12.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        RoundButton("拒绝", C.waiting, size = 56.dp) {
            onCommand(WatchCommand.Reject(cid(), s.sessionId, w?.requestId))
        }
        RoundButton("允许", C.done, size = 56.dp) {
            onCommand(WatchCommand.Allow(cid(), s.sessionId, w?.requestId))
        }
    }
}

/** W6 变体 · AskUserQuestion：选项即点即答；多问顺序推进，答完最后一问自动发送 */
@Composable
private fun AskBody(
    s: SessionState,
    w: WaitingRequest,
    qs: List<AskQuestion>,
    onCommand: (WatchCommand) -> Unit,
    cid: () -> String,
) {
    var qi by remember(w.requestId) { mutableStateOf(0) }
    var answers by remember(w.requestId) { mutableStateOf(listOf<String>()) }
    val q = qs.getOrNull(qi) ?: return
    Spacer(Modifier.height(6.dp))
    Text(
        if (qs.size > 1) "提问 ${qi + 1}/${qs.size}" else "Claude 在提问",
        color = C.waiting,
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
        maxLines = 1,
    )
    Spacer(Modifier.height(3.dp))
    Text(
        q.question,
        color = C.textPrimary,
        fontSize = 11.sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(8.dp))
    Column(
        verticalArrangement = Arrangement.spacedBy(5.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        q.options.forEach { o ->
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(C.surface)
                    .border(0.8.dp, C.primary.copy(alpha = 0.35f), RoundedCornerShape(12.dp))
                    .clickable {
                        val next = answers + o.label
                        if (qi + 1 < qs.size) {
                            answers = next
                            qi += 1
                        } else {
                            onCommand(WatchCommand.Answer(cid(), s.sessionId, w.requestId, next))
                        }
                    }
                    .padding(horizontal = 12.dp, vertical = 4.dp),
            ) {
                Text(
                    o.label,
                    color = C.textPrimary,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
    Spacer(Modifier.height(5.dp))
    Text(
        "跳过",
        color = C.faintLabel,
        fontSize = 10.sp,
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .clickable { onCommand(WatchCommand.Reject(cid(), s.sessionId, w.requestId, "用户未作答，跳过")) }
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/** W7 · Error：错误信息 + 查看(W2)/重试（规范 §12）。 */@Composable
private fun ErrorBody(
    s: SessionState,
    onCommand: (WatchCommand) -> Unit,
    cid: () -> String,
    onOpenTimeline: () -> Unit,
) {
    Spacer(Modifier.height(5.dp))
    Text(
        s.lastError ?: "未知错误",
        color = C.error.copy(alpha = 0.9f),
        fontSize = 11.sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(12.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        RoundButton("查看", C.textSecondary, size = 56.dp, onClick = onOpenTimeline)
        RoundButton("重试", C.primary, size = 56.dp) {
            onCommand(WatchCommand.Message(cid(), s.sessionId, "请重试上一次失败的操作"))
        }
    }
}

/** W8 · Done：完成摘要 + 任务完成度 + 文件变化 + 耗时（规范 §12）。 */
@Composable
private fun DoneBody(s: SessionState) {
    s.actionSummary?.let {
        Spacer(Modifier.height(4.dp))
        Text(it, color = C.textSecondary, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    if (s.todos.isNotEmpty()) {
        val done = s.todos.count { it.isDone }
        Spacer(Modifier.height(3.dp))
        Text(
            if (done == s.todos.size) "任务全部完成 ☑${done}"
            else "任务 ☑$done/${s.todos.size}",
            color = if (done == s.todos.size) C.done else C.textSecondary,
            fontSize = 11.sp,
            maxLines = 1,
        )
    }
    Spacer(Modifier.height(10.dp))
    StatsRow(s)
    s.durationMs?.let {
        Spacer(Modifier.height(5.dp))
        Text(formatDuration(it), color = C.textSecondary, fontSize = 11.sp)
    }
}

/** 统计行：文件 / +新增 / -删除（规范 §5）。 */
@Composable
fun StatsRow(s: SessionState) {
    val st = s.stats
    if (st.filesChanged == 0 && st.linesAdded == 0 && st.linesDeleted == 0) return
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("${st.filesChanged}", color = C.textPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        Text(" 文件", color = C.textSecondary, fontSize = 10.sp)
        Spacer(Modifier.padding(horizontal = 5.dp))
        Text("+${st.linesAdded}", color = C.working, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.padding(horizontal = 5.dp))
        Text("-${st.linesDeleted}", color = C.waiting, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

/** 活动强度 = 最近 3 分钟事件数；无时间线数据时按状态降级推导。 */
fun activityIntensity(events: List<RecentEvent>, s: SessionState): Int {
    if (events.isEmpty()) return if (s.status == SessionStatus.WORKING) 3 else 0
    val cutoff = System.currentTimeMillis() - 3 * 60_000
    return events.count { it.ts >= cutoff }.coerceIn(0, 7)
}
