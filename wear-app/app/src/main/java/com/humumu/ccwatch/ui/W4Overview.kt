package com.humumu.ccwatch.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.SessionStatus

private val attention = mapOf(
    SessionStatus.WAITING to 0,
    SessionStatus.ERROR to 1,
    SessionStatus.WORKING to 2,
    SessionStatus.DONE to 3,
)

/**
 * W4 · Session 总览（规范 §9）：按需要关注程度排序（Waiting/Error → Working → Done）。
 * 点击进入该 Session 的 W1。
 */
@Composable
fun W4Overview(
    sessions: List<SessionState>,
    onSelect: (SessionState) -> Unit,
    onSettings: () -> Unit,
) {
    val listState = rememberScalingLazyListState()
    val sorted = remember(sessions) {
        sessions.sortedWith(
            compareBy<SessionState> { attention[it.status] ?: 9 }.thenByDescending { it.updatedAt }
        )
    }
    Scaffold(
        modifier = Modifier.fillMaxSize().background(C.bg),
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(listState) },
    ) {
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item { MenuHeader("Session 总览") }
            if (sorted.isEmpty()) {
                item { Text("暂无会话", color = C.textSecondary, fontSize = 12.sp, modifier = Modifier.padding(top = 16.dp)) }
            } else {
                items(sorted, key = { it.sessionId }) { s ->
                    OverviewRow(s) { onSelect(s) }
                }
            }
            item {
                Text(
                    "⚙ 设置",
                    color = C.faintLabel,
                    fontSize = 11.sp,
                    modifier = Modifier
                        .clickable(onClick = onSettings)
                        .padding(top = 10.dp, bottom = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun OverviewRow(s: SessionState, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 6.dp),
    ) {
        StatusIcon(s.status, 17.dp)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(
                s.title,
                color = C.textPrimary,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    statusLabelZh(s.status),
                    color = statusColor(s.status),
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Medium,
                )
                s.actionSummary?.let {
                    Text(
                        " · ${it.take(14)}",
                        color = C.textSecondary,
                        fontSize = 10.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Spacer(Modifier.width(6.dp))
        Text(
            formatDuration((s.durationMs ?: s.elapsedHint) ?: (System.currentTimeMillis() - s.startedAt)),
            color = C.textSecondary,
            fontSize = 10.sp,
        )
    }
}
