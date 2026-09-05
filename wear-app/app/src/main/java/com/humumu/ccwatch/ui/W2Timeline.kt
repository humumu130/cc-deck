package com.humumu.ccwatch.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Text
import com.humumu.ccwatch.protocol.CronTask
import com.humumu.ccwatch.protocol.RecentEvent
import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.TodoItem

/**
 * W2 · 事件时间线（规范 §6）：只展示当前 Session 事件，禁止左右切 Session。
 * 最新在上方；上滑看更新，下滑看更早。
 */
@Composable
fun W2Timeline(s: SessionState, events: List<RecentEvent>) {
    val listState = rememberScalingLazyListState(0, 0)
    val newestFirst = remember(events) { events.asReversed() }
    var fullText by remember { mutableStateOf<String?>(null) }
    Box(Modifier.fillMaxSize()) {
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            // TODO(圆柱透视): 暂缓（2026-08-25 用户决策：优先流畅度）。
            // 调查结论：wear-compose 1.4.0 的 SLC 缩放管线对 compose 版本极其敏感——
            // BOM 2025.01.00(compose 1.7.6) 下 item scale/alpha 变换完全失效（像素测量证实）；
            // BOM 2024.09.00(1.7.0) 下滚动后生效，但初入页面(未滚动)仍不缩放，且
            // 自定义 scalingParams 叠加后再次失效。graphicsLayer 手动变换渲染正常。
            // 若重做：升级 wear-compose 到配对最新 compose 的版本，或绕过 SLC 自带变换、
            // 在 EventRow 上按 visibleItemsInfo 偏移手动挂 graphicsLayer 圆柱曲线。
        ) {
            item {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("↑", color = C.textSecondary, fontSize = 12.sp)
                        Spacer(Modifier.width(6.dp))
                        Text(
                            s.title,
                            color = C.textPrimary,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(statusLabelEn(s.status), color = statusColor(s.status), fontSize = 10.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
            if (s.todos.isNotEmpty()) {
                item(key = "todos") { TodosCard(s.todos) }
            }
            if (s.cronTasks.isNotEmpty()) {
                item(key = "crons") { CronCard(s.cronTasks) }
            }
            if (newestFirst.isEmpty()) {
                item {
                    Text("暂无事件", color = C.textSecondary, fontSize = 12.sp, modifier = Modifier.padding(top = 20.dp))
                }
            } else {
                // key 必须有：live 事件从顶部插入时保持条目身份，否则整表内容下移、
                // 滚动锚点被顶偏，中央放大看起来"永远追不上"
                items(newestFirst, key = { "${it.ts}|${it.kind}|${it.text}" }) { e ->
                    EventRow(e, onOpenFull = { fullText = e.full })
                }
            }
            item {
                Text("↓", color = C.textSecondary, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp, bottom = 10.dp))
            }
        }
        fullText?.let { full ->
            FullTextOverlay(full, onClose = { fullText = null })
        }
    }
}

/** 任务清单卡：进度 + 未完成任务（最多 4 条 + 溢出行） */
@Composable
private fun TodosCard(todos: List<TodoItem>) {
    val done = todos.count { it.isDone }
    val open = todos.filter { !it.isDone }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 26.dp, vertical = 4.dp),
    ) {
        Text("任务 $done/${todos.size}", color = C.working, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        open.take(4).forEach { t ->
            Spacer(Modifier.height(2.dp))
            Text(
                (if (t.status == "in_progress") "◐ " else "☐ ") + t.label,
                color = if (t.status == "in_progress") C.textPrimary else C.textSecondary,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Start,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (open.size > 4) {
            Spacer(Modifier.height(2.dp))
            Text("…还有 ${open.size - 4} 项", color = C.textSecondary, fontSize = 10.sp)
        }
    }
}

/** 定时任务只读卡（#288 A 类①）："定时任务有没有排上"的抬腕速览位；
 *  ⏰ 运行中排程 / ⏸ 已暂停，暂停、删除等操作去手机做。结构对齐 TodosCard。 */
@Composable
private fun CronCard(tasks: List<CronTask>) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 26.dp, vertical = 4.dp),
    ) {
        Text("定时任务 ${tasks.size}", color = C.primary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        tasks.take(4).forEach { t ->
            Spacer(Modifier.height(2.dp))
            Text(
                if (t.paused == true) "⏸ ${t.name} · 已暂停"
                else "⏰ ${t.name} · ${t.nextRunAt?.takeIf { it > 0 }?.let { formatNextRun(it) } ?: "待排期"}",
                color = if (t.paused == true) C.textSecondary else C.textPrimary,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Start,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (tasks.size > 4) {
            Spacer(Modifier.height(2.dp))
            Text("…还有 ${tasks.size - 4} 项", color = C.textSecondary, fontSize = 10.sp)
        }
    }
}

@Composable
private fun EventRow(e: RecentEvent, onOpenFull: () -> Unit) {
    val openable = e.kind == "assistant_text" && e.full != null
    Row(
        verticalAlignment = Alignment.Top,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 22.dp, vertical = 6.dp)
            .then(
                if (openable) Modifier.clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { onOpenFull() } else Modifier
            ),
    ) {
        Text(
            formatClock(e.ts),
            color = C.textSecondary,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.width(36.dp).padding(top = 2.dp),
        )
        Spacer(Modifier.width(4.dp))
        Box(Modifier.padding(top = 7.dp).size(5.dp).background(eventColor(e), CircleShape))
        Spacer(Modifier.width(7.dp))
        Column(modifier = Modifier.weight(1f)) {
            val headline = when (e.kind) {
                "tool_use" -> e.text
                "tool_result" -> e.text
                "user_message" -> "我: ${e.text}"
                "assistant_text" -> plainMd(e.text)
                else -> e.text
            }
            Text(
                if (e.streaming) "$headline ▌" else headline,
                color = if (e.kind == "assistant_text") C.textPrimary else C.textSecondary,
                fontSize = 12.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (openable) {
                Text(
                    "全文 ${e.full!!.length} 字 ›",
                    color = C.primary,
                    fontSize = 9.sp,
                    maxLines = 1,
                )
            }
            e.tool?.let {
                Text(it, color = C.faintLabel, fontSize = 9.sp, maxLines = 1)
            }
        }
    }
}

private fun eventColor(e: RecentEvent): Color = when {
    e.isError -> C.error
    e.isDone -> C.done
    e.kind == "assistant_text" -> C.primary
    e.kind == "tool_use" -> C.working
    e.kind == "user_message" -> C.done
    else -> C.textSecondary
}

/**
 * 全文查看页：assistant 完整回复（relay 下发 full 原文时才可进）。
 * 段落切条展示（圆屏单块长文会缩成蚂蚁字），点按任意处或右滑返回。
 */
@Composable
private fun FullTextOverlay(text: String, onClose: () -> Unit) {
    BackHandler(enabled = true) { onClose() }
    val chunks = remember(text) { chunkText(plainMd(text)) }
    Box(
        Modifier
            .fillMaxSize()
            .background(C.bg)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { onClose() },
    ) {
        ScalingLazyColumn(horizontalAlignment = Alignment.CenterHorizontally) {
            item {
                Text(
                    "完整回复 · ${text.length} 字",
                    color = C.primary,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.padding(top = 10.dp, bottom = 6.dp),
                )
            }
            items(chunks) { c ->
                Text(
                    c,
                    color = C.textPrimary,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Start,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 26.dp, vertical = 3.dp),
                )
            }
            item {
                Text("‹ 点按返回", color = C.faintLabel, fontSize = 10.sp, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp))
            }
        }
    }
}

/** 按换行切段，超长段硬折（约 90 字/条，圆屏 SLC 条目舒适宽度）。 */
private fun chunkText(text: String): List<String> {
    val out = mutableListOf<String>()
    for (para in text.split('\n')) {
        val p = para.trim()
        if (p.isEmpty()) continue
        var i = 0
        while (i < p.length) {
            out.add(p.substring(i, minOf(i + 90, p.length)))
            i += 90
        }
    }
    return out
}
