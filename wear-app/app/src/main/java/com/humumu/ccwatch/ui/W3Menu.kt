package com.humumu.ccwatch.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.material.Text
import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.SessionStatus
import com.humumu.ccwatch.protocol.WatchCommand
import kotlin.math.cos
import kotlin.math.sin
import java.util.UUID

/**
 * W3 · Session 操作菜单（规范 §7）：表圈式环形菜单。
 * 按钮坐在轨道环上（像表圈刻度），Canvas 矢量图标 + 微标签；中性操作灰阶、
 * 停止红 / 语音品牌紫跳前；中心为状态枢纽（图标+会话名+状态色描边）。
 */
@Composable
fun W3Menu(
    s: SessionState,
    onCommand: (WatchCommand) -> Unit,
    onVoice: () -> Unit,
    onMore: () -> Unit,
    onClose: () -> Unit,
) {
    var confirmStop by remember { mutableStateOf(false) }
    val cid = { UUID.randomUUID().toString() }
    val scale by animateFloatAsState(if (confirmStop) 0.86f else 1f, tween(140), label = "menuScale")
    val menuBg = Brush.radialGradient(
        listOf(lerp(C.bg, C.surface, 0.32f), C.bg),
    )
    Box(
        Modifier
            .fillMaxSize()
            .background(menuBg)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { onClose() },
    ) {
        // 轨道环：按钮中心所在的"表圈"
        Box(
            Modifier
                .align(Alignment.Center)
                .size(150.dp)
                .border(1.dp, C.textPrimary.copy(alpha = 0.07f), CircleShape),
        )
        Box(Modifier.fillMaxSize().scale(scale)) {
            RingSlot(angle = -150f) {
                MenuBtn("继续", C.textSecondary, MenuIconKind.PLAY) {
                    if (s.status == SessionStatus.WAITING) {
                        onCommand(WatchCommand.Allow(cid(), s.sessionId, s.waitingRequest?.requestId))
                    } else {
                        onCommand(WatchCommand.Message(cid(), s.sessionId, "继续"))
                    }
                    onClose()
                }
            }
            RingSlot(angle = -90f) {
                MenuBtn("停止", C.waiting, MenuIconKind.STOP) { confirmStop = true }
            }
            RingSlot(angle = -30f) {
                MenuBtn("重试", C.textSecondary, MenuIconKind.RETRY) {
                    onCommand(WatchCommand.Message(cid(), s.sessionId, "请重试上一次失败的操作"))
                    onClose()
                }
            }
            RingSlot(angle = 30f) {
                MenuBtn("解释", C.textSecondary, MenuIconKind.HELP) {
                    onCommand(WatchCommand.Message(cid(), s.sessionId, "请简要解释当前状态和进度"))
                    onClose()
                }
            }
            RingSlot(angle = 90f) {
                MenuBtn("语音", C.primary, MenuIconKind.MIC, glow = true, onClick = onVoice)
            }
            RingSlot(angle = 150f) {
                MenuBtn("更多", C.textSecondary, MenuIconKind.DOTS, onClick = onMore)
            }
            // 中心枢纽：状态图标 + Session 名，状态色描边呼应当前状态，点击关闭
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(86.dp)
                    .clip(CircleShape)
                    .background(
                        Brush.verticalGradient(
                            listOf(lerp(C.surface, C.bg, 0.18f), C.surface),
                        )
                    )
                    .border(1.dp, statusColor(s.status).copy(alpha = 0.30f), CircleShape)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                    ) { onClose() },
            ) {
                StatusIcon(s.status, 23.dp)
                Spacer(Modifier.height(5.dp))
                Text(
                    s.title,
                    color = C.textSecondary,
                    fontSize = 9.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 9.dp),
                )
            }
        }
        if (confirmStop) {
            StopConfirm(
                s,
                onCancel = { confirmStop = false },
                onConfirm = {
                    confirmStop = false
                    onCommand(WatchCommand.Stop(cid(), s.sessionId))
                    onClose()
                },
            )
        }
    }
}

/** 环形槽位：按角度把按钮放在半径 75dp 的轨道上（1.4" 圆盘安全区）。offset{} 入参是像素，必须 dp.toPx()。 */
@Composable
private fun BoxScope.RingSlot(angle: Float, content: @Composable BoxScope.() -> Unit) {
    val rad = Math.toRadians(angle.toDouble())
    Box(
        Modifier.align(Alignment.Center).offset {
            IntOffset(
                (cos(rad) * 75.dp.toPx()).toInt(),
                (sin(rad) * 75.dp.toPx()).toInt(),
            )
        },
    ) {
        content()
    }
}

/** 菜单钮：深底圆钮 + 语义色图标/描边，按压缩放 + 微光反馈；语音等强调钮外加辉光。 */
@Composable
private fun MenuBtn(
    label: String,
    accent: Color,
    icon: MenuIconKind,
    glow: Boolean = false,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val btnScale by animateFloatAsState(if (pressed) 0.90f else 1f, tween(90), label = "btnScale")
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(50.dp)
            .scale(btnScale)
            .clip(CircleShape)
            .background(
                Brush.verticalGradient(
                    listOf(lerp(C.surface, C.textPrimary, 0.05f), C.surface),
                )
            )
            .border(
                width = if (pressed) 1.6.dp else 1.dp,
                color = accent.copy(alpha = if (pressed) 1f else 0.75f),
                shape = CircleShape,
            )
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
    ) {
        if (glow && !pressed) {
            Box(
                Modifier
                    .fillMaxSize()
                    .padding(2.dp)
                    .border(3.dp, accent.copy(alpha = 0.16f), CircleShape)
            )
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            MenuIcon(icon, accent, 17.dp)
            Spacer(Modifier.height(2.dp))
            Text(
                label,
                color = accent,
                fontSize = 8.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
        }
    }
}

private enum class MenuIconKind { PLAY, STOP, RETRY, HELP, MIC, DOTS }

/** 纯 Canvas 矢量小图标：文字字形在 ColorOS Watch 字体覆盖不稳，一律用基本图形绘制。 */
@Composable
private fun MenuIcon(kind: MenuIconKind, color: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val c = Offset(w / 2f, h / 2f)
        when (kind) {
            MenuIconKind.PLAY -> {
                val p = Path().apply {
                    moveTo(w * 0.34f, h * 0.16f)
                    lineTo(w * 0.34f, h * 0.84f)
                    lineTo(w * 0.86f, h * 0.50f)
                    close()
                }
                drawPath(p, color)
            }
            MenuIconKind.STOP ->
                drawRoundRect(
                    color,
                    topLeft = Offset(w * 0.27f, h * 0.27f),
                    size = Size(w * 0.46f, h * 0.46f),
                    cornerRadius = CornerRadius(w * 0.10f),
                )
            MenuIconKind.RETRY -> {
                val r = w * 0.30f
                drawArc(
                    color, startAngle = 0f, sweepAngle = 270f, useCenter = false,
                    topLeft = Offset(c.x - r, c.y - r), size = Size(r * 2, r * 2),
                    style = Stroke(w * 0.13f, cap = StrokeCap.Round),
                )
                // 弧终点在 270°（正上方），顺时针切线朝 +x，箭头指向右侧
                val px = c.x + r * cos(Math.toRadians(270.0)).toFloat()
                val py = c.y + r * sin(Math.toRadians(270.0)).toFloat()
                val p = Path().apply {
                    moveTo(px + w * 0.17f, py)
                    lineTo(px - w * 0.05f, py - w * 0.11f)
                    lineTo(px - w * 0.05f, py + w * 0.11f)
                    close()
                }
                drawPath(p, color)
            }
            MenuIconKind.HELP -> {
                drawArc(
                    color, startAngle = 140f, sweepAngle = 230f, useCenter = false,
                    topLeft = Offset(w * 0.16f, h * 0.06f), size = Size(w * 0.68f, h * 0.60f),
                    style = Stroke(w * 0.14f, cap = StrokeCap.Round),
                )
                drawCircle(color, radius = w * 0.085f, center = Offset(c.x, h * 0.86f))
            }
            MenuIconKind.MIC -> {
                drawRoundRect(
                    color,
                    topLeft = Offset(w * 0.34f, h * 0.06f),
                    size = Size(w * 0.32f, h * 0.40f),
                    cornerRadius = CornerRadius(w * 0.16f),
                )
                drawArc(
                    color, startAngle = 0f, sweepAngle = 180f, useCenter = false,
                    topLeft = Offset(w * 0.20f, h * 0.24f), size = Size(w * 0.60f, h * 0.52f),
                    style = Stroke(w * 0.09f, cap = StrokeCap.Round),
                )
                drawLine(color, Offset(c.x, h * 0.76f), Offset(c.x, h * 0.86f), w * 0.09f, StrokeCap.Round)
                drawLine(color, Offset(w * 0.31f, h * 0.92f), Offset(w * 0.69f, h * 0.92f), w * 0.09f, StrokeCap.Round)
            }
            MenuIconKind.DOTS -> {
                drawCircle(color, radius = w * 0.085f, center = Offset(c.x, h * 0.18f))
                drawCircle(color, radius = w * 0.085f, center = Offset(c.x, h * 0.50f))
                drawCircle(color, radius = w * 0.085f, center = Offset(c.x, h * 0.82f))
            }
        }
    }
}

/** Stop 二次确认（规范 §7：Stop 高风险必须二次确认）。 */
@Composable
fun StopConfirm(s: SessionState, onCancel: () -> Unit, onConfirm: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.fillMaxSize().background(C.bg).padding(horizontal = 24.dp),
    ) {
        Spacer(Modifier.height(28.dp))
        Text("STOP SESSION?", color = C.waiting, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
        Spacer(Modifier.height(6.dp))
        Text(
            s.title,
            color = C.textPrimary,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(3.dp))
        Text(
            "已运行 " + formatDuration((s.durationMs ?: s.elapsedHint) ?: (System.currentTimeMillis() - s.startedAt)),
            color = C.textSecondary,
            fontSize = 11.sp,
        )
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            RoundButton("取消", C.textSecondary, size = 54.dp, onClick = onCancel)
            RoundButton("停止", C.waiting, size = 54.dp, onClick = onConfirm)
        }
    }
}

/**
 * W3-2 · 更多操作（规范 §8）。复制/导出需手机协同（v0.3 规划），当前提示不可用。
 */
@Composable
fun W3More(
    s: SessionState,
    onCommand: (WatchCommand) -> Unit,
    onOpenTimeline: () -> Unit,
    onBack: () -> Unit,
) {
    var hint by remember { mutableStateOf<String?>(null) }
    val deletable = s.status != SessionStatus.WORKING && s.status != SessionStatus.WAITING
    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize().background(C.bg),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item { MenuHeader("更多操作") }
        item {
          MoreItem("查看日志") { onOpenTimeline() }
        }
        item {
          MoreItem("查看统计") { hint = "${s.stats.filesChanged} 文件 · +${s.stats.linesAdded} -${s.stats.linesDeleted} · ${formatDuration((s.durationMs ?: s.elapsedHint) ?: (System.currentTimeMillis() - s.startedAt))}" }
        }
        item {
          MoreItem("复制内容") { hint = "需手机端协同，暂不可用" }
        }
        item {
          MoreItem("导出结果") { hint = "需手机端协同，暂不可用" }
        }
        item {
          MoreItem(
              "关闭会话",
              color = C.waiting,
              enabled = deletable,
          ) {
              if (deletable) onCommand(WatchCommand.Delete(UUID.randomUUID().toString(), s.sessionId))
          }
        }
        hint?.let { h ->
            item {
                Text(
                    h,
                    color = C.textSecondary,
                    fontSize = 10.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 30.dp, vertical = 4.dp),
                )
            }
        }
        item {
            Text("‹ 返回", color = C.faintLabel, fontSize = 11.sp, modifier = Modifier
                .padding(top = 6.dp)
                .clickable { onBack() })
        }
    }
}

@Composable
fun MenuHeader(text: String) {
    Text(
        text,
        color = C.textPrimary,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
    )
}

@Composable
fun MoreItem(label: String, color: Color = C.textPrimary, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .padding(vertical = 3.dp)
            .background(
                if (enabled) C.surface else C.surface.copy(alpha = 0.5f),
                RoundedCornerShape(14.dp),
            )
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 18.dp, vertical = 9.dp),
    ) {
        Text(
            label,
            color = if (enabled) color else C.faintLabel,
            fontSize = 12.sp,
            maxLines = 1,
        )
    }
}
