package com.humumu.ccwatch.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition

/** 数据源：演示 / 直连 Relay（主通道）/ 手机网关（GMS 表） */
enum class SourceMode { DEMO, RELAY, GMS }

private val hostPresets = listOf("192.168.0.101:8787", "192.168.0.105:8787")
private val tokenPresets = listOf("devtoken")

/**
 * 设置页（W4 入口）：数据源选择 + Relay 地址/Token（预设一键填入 + 手动输入）。
 * 保存即生效（MainActivity 重建仓库）。
 */
@Composable
fun SettingsScreen(
    mode: SourceMode,
    host: String,
    token: String,
    connected: Boolean,
    onSave: (SourceMode, String, String) -> Unit,
) {
    var m by remember { mutableStateOf(mode) }
    var h by remember { mutableStateOf(host) }
    var t by remember { mutableStateOf(token) }
    val listState = rememberScalingLazyListState()
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
            item { MenuHeader("设置") }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SourceChip("演示", m == SourceMode.DEMO) { m = SourceMode.DEMO }
                    SourceChip("直连", m == SourceMode.RELAY) { m = SourceMode.RELAY }
                    SourceChip("手机", m == SourceMode.GMS) { m = SourceMode.GMS }
                }
            }
            if (m == SourceMode.RELAY) {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        hostPresets.forEach { p ->
                            SourceChip(p, h == p) { h = p }
                        }
                    }
                }
                item {
                    MiniField(h, { h = it }, "Relay 地址", KeyboardType.Uri)
                }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        tokenPresets.forEach { p ->
                            SourceChip(p, t == p) { t = p }
                        }
                    }
                }
                item {
                    MiniField(t, { t = it }, "Token", KeyboardType.Ascii)
                }
                item {
                    Text(
                        if (connected) "● 已连接" else "○ 未连接",
                        color = if (connected) C.done else C.offline,
                        fontSize = 10.sp,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            item {
                Spacer(Modifier.height(4.dp))
                MoreItem("保存并生效", color = C.primary) {
                    onSave(m, h.trim(), t.trim())
                }
            }
        }
    }
}

/** 紧凑输入框：compose material TextField 深色化（wear material 无 TextField）。 */
@Composable
private fun MiniField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    type: KeyboardType,
) {
    androidx.compose.material.TextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp, color = C.textPrimary),
        placeholder = {
            Text(label, color = C.textSecondary, fontSize = 11.sp)
        },
        keyboardOptions = KeyboardOptions(keyboardType = type),
        colors = androidx.compose.material.TextFieldDefaults.textFieldColors(
            textColor = C.textPrimary,
            cursorColor = C.primary,
            backgroundColor = Color.Transparent,
            focusedIndicatorColor = C.primary,
            unfocusedIndicatorColor = C.surface,
            placeholderColor = C.textSecondary,
        ),
        modifier = Modifier.fillMaxSize().padding(horizontal = 14.dp),
    )
}

@Composable
private fun SourceChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .clickable(onClick = onClick)
            .background(if (selected) C.primary else C.surface, RoundedCornerShape(10.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Text(
            label,
            color = if (selected) C.bg else C.textSecondary,
            fontSize = if (label.length > 6) 9.sp else 11.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
    }
}
