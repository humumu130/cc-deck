package com.humumu.ccwatch.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
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

/** 数据源：蓝牙经手机（#380 主通道，零配置）/ 直连 Relay / 手机网关（GMS 表）/ 演示 */
enum class SourceMode { DEMO, RELAY, GMS, BT }

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
    // #316 自动发现配对浮层：mDNS 找 relay → 手表屏显 6 位码 → 手机核对授权 → 落库直连
    var pairing by remember { mutableStateOf(false) }
    val listState = rememberScalingLazyListState()
    Box(Modifier.fillMaxSize().background(C.bg)) {
    Scaffold(
        modifier = Modifier.fillMaxSize(),
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
                    SourceChip("蓝牙", m == SourceMode.BT) { m = SourceMode.BT }
                    SourceChip("直连", m == SourceMode.RELAY) { m = SourceMode.RELAY }
                }
            }
            if (m == SourceMode.BT) {
                item {
                    Text(
                        "数据经手机蓝牙中继，手表免联网免配置。手机 App 连着即可，无需在此输入任何内容。",
                        color = C.textSecondary, fontSize = 10.sp, textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 26.dp, vertical = 2.dp),
                    )
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SourceChip("手机GMS", m == SourceMode.GMS) { m = SourceMode.GMS }
                    SourceChip("演示", m == SourceMode.DEMO) { m = SourceMode.DEMO }
                }
            }
            if (m == SourceMode.RELAY) {
                item {
                    MoreItem("📡 自动发现配对", color = C.primary) { pairing = true }
                }
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
    if (pairing) {
        PairingOverlay(
            onClose = { pairing = false },
            onGranted = { hostPort, token ->
                pairing = false
                onSave(SourceMode.RELAY, hostPort, token)
            },
        )
    }
    }
}

/**
 * #316 配对浮层：发现 → 显示 relay 下发的 6 位码（手机核对）→ 授权即落库。
 * 失败可重试（重建 WatchPairer）；BT 网络共享下组播不通，提示连 WiFi 再试
 */
@Composable
private fun PairingOverlay(
    onClose: () -> Unit,
    onGranted: (hostPort: String, token: String) -> Unit,
) {
    val context = LocalContext.current
    var attempt by remember { mutableStateOf(0) }
    val pairer = remember(attempt) { com.humumu.ccwatch.data.WatchPairer(context) }
    val st by pairer.state.collectAsState()
    DisposableEffect(attempt) {
        pairer.onGranted = onGranted
        pairer.start()
        onDispose { pairer.close() }
    }
    // 全局右滑返回只收浮层（不退整个设置页丢未保存编辑）；ShowCode 态禁点空白取消
    // （抬腕/袖口误触会白白收掉配对，手机弹窗悬到超时）
    androidx.activity.compose.BackHandler(enabled = true) { onClose() }
    Box(
        Modifier
            .fillMaxSize()
            .background(C.bg)
            .clickable(enabled = st is com.humumu.ccwatch.data.PairState.Discovering) { onClose() },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.padding(horizontal = 16.dp),
        ) {
            when (val s = st) {
                is com.humumu.ccwatch.data.PairState.Discovering -> {
                    Text("📡 正在发现 PC…", color = C.textSecondary, fontSize = 12.sp)
                    Text("需与 PC 同一 WiFi", color = C.offline, fontSize = 10.sp)
                }
                is com.humumu.ccwatch.data.PairState.ShowCode -> {
                    Text("在手机上核对", color = C.textSecondary, fontSize = 10.sp)
                    Text(s.code, color = C.primary, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                    Text("等待授权…", color = C.textSecondary, fontSize = 10.sp)
                }
                is com.humumu.ccwatch.data.PairState.Fail -> {
                    Text("✕", color = C.offline, fontSize = 18.sp)
                    Text(s.reason, color = C.offline, fontSize = 10.sp, textAlign = TextAlign.Center)
                }
            }
            Spacer(Modifier.height(2.dp))
            if (st is com.humumu.ccwatch.data.PairState.Fail) {
                MoreItem("重试", color = C.primary) { attempt++ }
            } else if (st is com.humumu.ccwatch.data.PairState.ShowCode) {
                MoreItem("取消", color = C.textSecondary) { onClose() }
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
