package com.humumu.ccwatch.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Text

/** 圆形操作按钮（W3 环形菜单 / W6 Allow-Reject / W7 查看-重试 共用）。 */
@Composable
fun RoundButton(
    label: String,
    color: Color,
    size: Dp,
    fontSize: Int = 12,
    border: Brush? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(
            backgroundColor = color.copy(alpha = 0.16f),
            contentColor = color,
            disabledBackgroundColor = C.surface.copy(alpha = 0.6f),
            disabledContentColor = C.textSecondary,
        ),
        modifier = Modifier
            .size(size)
            .then(if (border != null) Modifier.background(border, CircleShape) else Modifier),
        shape = CircleShape,
    ) {
        Text(label, fontSize = fontSize.sp, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

/**
 * W1 活动强度点：7 个点，密度=最近 3 分钟事件数（规范 §5：表达活动强度，非真实百分比）。
 */
@Composable
fun ActivityDots(intensity: Int, color: Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        repeat(7) { i ->
            val active = i < intensity
            Box(
                Modifier
                    .size(4.dp)
                    .alpha(if (active) 1f else 0.28f)
                    .background(if (active) color else C.textSecondary, CircleShape)
            )
        }
    }
}

/** W1 底部分页点：当前 Session 在全部 Session 中的位置（规范 §5）。 */
@Composable
fun PaginationDots(total: Int, current: Int) {
    if (total <= 1) return
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        repeat(total) { i ->
            Box(
                Modifier
                    .size(if (i == current) 5.dp else 3.dp)
                    .alpha(if (i == current) 0.95f else 0.4f)
                    .background(C.textPrimary, CircleShape)
            )
        }
    }
}

/** 断线徽标：保留最后数据但明确显示 OFFLINE（规范 §14）。 */
@Composable
fun OfflineChip() {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .background(C.surface, RoundedCornerShape(8.dp))
            .width(74.dp)
            .height(20.dp),
    ) {
        Text("OFFLINE", color = C.offline, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
    }
}
