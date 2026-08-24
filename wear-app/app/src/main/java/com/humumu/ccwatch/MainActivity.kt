package com.humumu.ccwatch

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.humumu.ccwatch.data.DataLayerRepository
import com.humumu.ccwatch.data.DemoRepository
import com.humumu.ccwatch.data.SessionRepo
import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.SessionStatus
import com.humumu.ccwatch.protocol.WatchCommand
import java.util.UUID

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("ccwatch", MODE_PRIVATE)
        val useDemo = BuildConfig.DEMO_DEFAULT && !prefs.contains("live_mode")
        setContent {
            var demo by remember { mutableStateOf(useDemo) }
            val repo = remember(demo) {
                if (demo) DemoRepository() else DataLayerRepository(applicationContext)
            }
            CcWatchTheme {
                App(repo) { demo = !demo; prefs.edit().putBoolean("live_mode", !demo).apply() }
            }
        }
    }
}

// ---------- 主题 ----------

object C {
    val bg = Color(0xFF050B12)
    val brandA = Color(0xFF4D9FFF)
    val brandB = Color(0xFF7C6CF2)
    val working = Color(0xFF2BD98F)
    val waiting = Color(0xFFF5B841)
    val error = Color(0xFFF0524F)
    val done = Color(0xFF4D9FFF)
    val textPrimary = Color(0xFFE8F0F8)
    val textSecondary = Color(0xFF8A9BA8)
}

@Composable
fun CcWatchTheme(content: @Composable () -> Unit) {
    MaterialTheme(colors = MaterialTheme.colors.copy(primary = C.brandA, background = C.bg)) {
        Box(Modifier.fillMaxSize().background(C.bg)) { content() }
    }
}

fun statusColor(s: SessionStatus) = when (s) {
    SessionStatus.WORKING -> C.working
    SessionStatus.WAITING -> C.waiting
    SessionStatus.ERROR -> C.error
    SessionStatus.DONE -> C.done
}

fun statusLabel(s: SessionStatus) = when (s) {
    SessionStatus.WORKING -> "工作中"
    SessionStatus.WAITING -> "等待确认"
    SessionStatus.ERROR -> "出错"
    SessionStatus.DONE -> "完成"
}

fun formatDuration(ms: Long): String {
    if (ms < 0) return "-"
    val total = ms / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%dh%02dm".format(h, m) else "%dm%02ds".format(m, s)
}

// ---------- 导航 ----------

@Composable
fun App(repo: SessionRepo, onToggleDemo: () -> Unit) {
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    val sessions by repo.sessions.collectAsState()
    val connected by repo.connected.collectAsState()
    val selected = sessions.firstOrNull { it.sessionId == selectedId }
    if (selected != null) {
        DetailScreen(selected, connected) { cmd -> repo.sendCommand(cmd) }
    } else {
        ListScreen(sessions, connected, onToggleDemo) { selectedId = it.sessionId }
    }
}

// ---------- 主列表 ----------

@Composable
fun ListScreen(
    sessions: List<SessionState>,
    connected: Boolean,
    onToggleDemo: () -> Unit,
    onSelect: (SessionState) -> Unit,
) {
    val listState = rememberScalingLazyListState()
    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(listState) },
    ) {
        if (!connected) {
            NotConnected()
            return@Scaffold
        }
        run {
            ScalingLazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (sessions.isEmpty()) {
                    item {
                        Text(
                            "暂无会话",
                            color = C.textSecondary,
                            modifier = Modifier.padding(top = 40.dp),
                        )
                    }
                } else {
                    items(sessions, key = { it.sessionId }) { s ->
                        SessionRow(s) { onSelect(s) }
                    }
                }
                item {
                    Chip(
                        onClick = onToggleDemo,
                        colors = ChipDefaults.secondaryChipColors(
                            contentColor = C.textSecondary,
                            secondaryContentColor = C.brandA,
                        ),
                        label = { Text("切换数据源", fontSize = 11.sp, maxLines = 1) },
                        secondaryLabel = { Text("演示 / 手机", fontSize = 10.sp, maxLines = 1) },
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun SessionRow(s: SessionState, onClick: () -> Unit) {
    Chip(
        onClick = onClick,
        colors = ChipDefaults.gradientBackgroundChipColors(
            startBackgroundColor = C.bg,
            endBackgroundColor = C.bg.copy(alpha = 0.86f),
        ),
        modifier = Modifier.fillMaxWidth(),
        icon = { StatusDot(s.status, size = 10) },
        label = {
            Text(
                s.title,
                color = C.textPrimary,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        secondaryLabel = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    formatDuration(durationOf(s)),
                    color = C.done,
                    fontSize = 11.sp,
                    fontFamily = tabularFont,
                )
                Spacer(Modifier.size(6.dp))
                Text(
                    s.actionSummary ?: "",
                    color = C.textSecondary,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(end = 0.dp),
                )
            }
        },
    )
}

private val tabularFont = androidx.compose.ui.text.font.FontFamily.Monospace

fun durationOf(s: SessionState): Long =
    s.durationMs ?: (System.currentTimeMillis() - s.startedAt)

@Composable
fun NotConnected() {
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .size(14.dp)
                .background(C.error.copy(alpha = 0.85f), CircleShape)
        )
        Spacer(Modifier.height(10.dp))
        Text("未连接手机", color = C.textPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(4.dp))
        Text(
            "请打开手机上的\nCloud Code Relay",
            color = C.textSecondary,
            fontSize = 11.sp,
            textAlign = TextAlign.Center,
        )
    }
}

// ---------- 详情页 ----------

@Composable
fun DetailScreen(s: SessionState, connected: Boolean, onCommand: (WatchCommand) -> Unit) {
    Scaffold(timeText = { TimeText() }) {
        val listState = rememberScalingLazyListState()
        Scaffold(timeText = {}, positionIndicator = { PositionIndicator(listState) }) {
            ScalingLazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                item {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.padding(top = 14.dp, bottom = 4.dp),
                    ) {
                        StatusDot(s.status, size = 26)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            statusLabel(s.status),
                            color = statusColor(s.status),
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            s.title,
                            color = C.textPrimary,
                            fontSize = 13.sp,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            textAlign = TextAlign.Center,
                        )
                        Text(
                            formatDuration(durationOf(s)) + " · " + (s.model ?: ""),
                            color = C.textSecondary,
                            fontSize = 11.sp,
                            fontFamily = tabularFont,
                        )
                    }
                }
                if (s.status == SessionStatus.WAITING && s.waitingRequest != null) {
                    val w = s.waitingRequest
                    item {
                        Text(
                            w.toolName,
                            color = C.waiting,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                        )
                        w.inputSummary?.let {
                            Text(
                                it, color = C.textSecondary, fontSize = 11.sp,
                                maxLines = 2, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    item {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            RoundAction("允许", C.working) {
                                onCommand(WatchCommand.Allow(UUID.randomUUID().toString(), s.sessionId))
                            }
                            RoundAction("拒绝", C.error) {
                                onCommand(WatchCommand.Reject(UUID.randomUUID().toString(), s.sessionId))
                            }
                        }
                    }
                }
                if (s.status == SessionStatus.ERROR) {
                    item {
                        Text(
                            s.lastError ?: "未知错误",
                            color = C.error.copy(alpha = 0.9f),
                            fontSize = 10.sp,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
                item {
                    RoundAction(
                        "停止",
                        Color(0xFF3A4652),
                        border = Brush.linearGradient(listOf(C.brandA, C.brandB)),
                    ) {
                        onCommand(WatchCommand.Stop(UUID.randomUUID().toString(), s.sessionId))
                    }
                }
            }
        }
    }
}

@Composable
fun RoundAction(label: String, color: Color, border: Brush? = null, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        colors = ButtonDefaults.primaryButtonColors(
            backgroundColor = color.copy(alpha = 0.22f),
            contentColor = color,
        ),
        modifier = Modifier
            .size(52.dp)
            .then(
                if (border != null)
                    Modifier.background(border, CircleShape).padding(1.5.dp)
                else Modifier
            ),
        shape = CircleShape,
    ) {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}

// ---------- 状态圆点（WORKING 呼吸动画） ----------

@Composable
fun StatusDot(status: SessionStatus, size: Int) {
    val color = statusColor(status)
    if (status == SessionStatus.WORKING) {
        val transition = rememberInfiniteTransition(label = "breath")
        val alpha by transition.animateFloat(
            initialValue = 0.35f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(900, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "alpha",
        )
        Box(
            Modifier
                .size(size.dp)
                .alpha(alpha)
                .background(color, CircleShape)
        )
    } else {
        Box(Modifier.size(size.dp).background(color, CircleShape))
    }
}
