package com.humumu.ccwatch.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.TextUnitType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import com.humumu.ccwatch.protocol.SessionStatus

/**
 * 状态图标：颜色 + 图形 + 文字三重编码（规范 §1）。
 * WORKING 实心圆(呼吸) / WAITING 半圆 / ERROR 圆内感叹号 / DONE 圆内对勾 / OFFLINE 空心圆。
 * 呼吸用步进式（~1.4Hz 两档），不跑 60fps 无限动画——手表 SoC 扛不住持续整屏重绘。
 */
@Composable
fun StatusIcon(status: SessionStatus?, size: Dp, modifier: Modifier = Modifier) {
    val color = status?.let { statusColor(it) } ?: C.offline
    val working = status == SessionStatus.WORKING
    var a by remember { mutableStateOf(1f) }
    LaunchedEffect(working) {
        if (!working) {
            a = 1f
            return@LaunchedEffect
        }
        while (true) {
            a = 0.45f
            delay(700)
            a = 1f
            delay(700)
        }
    }
    Canvas(modifier.size(size)) {
        val d = this.size.minDimension
        val stroke = Stroke(width = d * 0.14f, cap = StrokeCap.Round)
        when (status) {
            SessionStatus.WORKING -> {
                drawCircle(color.copy(alpha = 0.28f * a), radius = d * 0.48f)
                drawCircle(color.copy(alpha = a), radius = d * 0.30f)
            }
            SessionStatus.WAITING -> {
                // 圆环 + 下半实心：读作"半满仪表"。纯半圆(竖直切边)会被误认为图标被裁掉
                drawCircle(color, radius = d * 0.46f, style = Stroke(d * 0.10f))
                drawArc(
                    color, startAngle = 0f, sweepAngle = 180f, useCenter = true,
                    topLeft = Offset(d * 0.16f, d * 0.16f), size = Size(d * 0.68f, d * 0.68f),
                )
            }
            SessionStatus.ERROR -> {
                drawCircle(color, radius = d * 0.46f, style = Stroke(d * 0.11f))
                val w = stroke.width
                drawLine(color, Offset(d * 0.5f, d * 0.26f), Offset(d * 0.5f, d * 0.56f), w, StrokeCap.Round)
                drawCircle(color, radius = w / 2, center = Offset(d * 0.5f, d * 0.74f))
            }
            SessionStatus.DONE -> {
                drawCircle(color, radius = d * 0.46f, style = Stroke(d * 0.11f))
                val w = d * 0.12f
                drawLine(color, Offset(d * 0.28f, d * 0.52f), Offset(d * 0.45f, d * 0.68f), w, StrokeCap.Round)
                drawLine(color, Offset(d * 0.45f, d * 0.68f), Offset(d * 0.74f, d * 0.34f), w, StrokeCap.Round)
            }
            else -> { // OFFLINE / null
                drawCircle(C.offline.copy(alpha = 0.9f), radius = d * 0.44f, style = Stroke(d * 0.10f))
            }
        }
    }
}

/** 带文字的状态徽标行：图标 + 大写英文状态（W1/W6/W7/W8 头部） */
@Composable
fun StatusBadge(status: SessionStatus?, iconSize: Dp = 16.dp, fontSize: Int = 11) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        StatusIcon(status, iconSize)
        Spacer(Modifier.width(6.dp))
        Text(
            status?.let { statusLabelEn(it) } ?: "OFFLINE",
            color = status?.let { statusColor(it) } ?: C.offline,
            fontSize = TextUnit(fontSize.toFloat(), TextUnitType.Sp),
            fontWeight = FontWeight.Bold,
            letterSpacing = TextUnit(1.5f, TextUnitType.Sp),
        )
    }
}
