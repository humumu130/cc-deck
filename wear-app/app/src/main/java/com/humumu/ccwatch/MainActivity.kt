@file:OptIn(ExperimentalFoundationApi::class)

package com.humumu.ccwatch

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.humumu.ccwatch.data.DataLayerRepository
import com.humumu.ccwatch.data.DemoRepository
import com.humumu.ccwatch.data.RelayRepository
import com.humumu.ccwatch.data.SessionRepo
import com.humumu.ccwatch.notification.CommandBus
import com.humumu.ccwatch.notification.Notifier
import com.humumu.ccwatch.protocol.SessionStatus
import com.humumu.ccwatch.protocol.WatchCommand
import com.humumu.ccwatch.ui.C
import com.humumu.ccwatch.ui.CcWatchTheme
import com.humumu.ccwatch.ui.OfflineChip
import com.humumu.ccwatch.ui.PaginationDots
import com.humumu.ccwatch.ui.SettingsScreen
import com.humumu.ccwatch.ui.SourceMode
import com.humumu.ccwatch.ui.W1Card
import com.humumu.ccwatch.ui.W2Timeline
import com.humumu.ccwatch.ui.W3Menu
import com.humumu.ccwatch.ui.W3More
import com.humumu.ccwatch.ui.W4Overview
import com.humumu.ccwatch.ui.W5Voice
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("ccwatch", MODE_PRIVATE)
        Notifier.ensureChannels(this)
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        setContent {
            var pendingSid by remember { mutableStateOf(intent?.getStringExtra("sid")) }
            var mode by remember {
                mutableStateOf(
                    prefs.getString("mode", null)?.let { runCatching { SourceMode.valueOf(it) }.getOrNull() }
                        ?: if (BuildConfig.DEMO_DEFAULT) SourceMode.DEMO else SourceMode.GMS
                )
            }
            var host by remember { mutableStateOf(prefs.getString("host", "192.168.0.105:8787") ?: "") }
            var token by remember { mutableStateOf(prefs.getString("token", "") ?: "") }
            val repo = remember(mode, host, token) {
                when (mode) {
                    SourceMode.DEMO -> DemoRepository()
                    SourceMode.RELAY -> RelayRepository(host, token)
                    SourceMode.GMS -> DataLayerRepository(applicationContext)
                }
            }
            DisposableEffect(repo) { onDispose { repo.close() } }
            CcWatchTheme {
                App(
                    repo,
                    pendingSid = pendingSid,
                    onSidConsumed = { pendingSid = null },
                    mode = mode,
                    host = host,
                    token = token,
                    onSaveSettings = { m, h, t ->
                        mode = m
                        host = h
                        token = t
                        prefs.edit()
                            .putString("mode", m.name)
                            .putString("host", h)
                            .putString("token", t)
                            .apply()
                    },
                )
            }
        }
    }
}

// ---------- 导航状态机 ----------

private sealed class Screen {
    data object Home : Screen()
    data class Menu(val sid: String) : Screen()
    data class More(val sid: String) : Screen()
    data object Overview : Screen()
    data class Voice(val sid: String) : Screen()
    data object Settings : Screen()
}

@Composable
fun App(
    repo: SessionRepo,
    pendingSid: String?,
    onSidConsumed: () -> Unit,
    mode: SourceMode,
    host: String,
    token: String,
    onSaveSettings: (SourceMode, String, String) -> Unit,
) {
    val sessions by repo.sessions.collectAsState()
    val connected by repo.connected.collectAsState()
    val timelines by repo.timelines.collectAsState()
    var screen by remember { mutableStateOf<Screen>(Screen.Home) }
    var feedback by remember { mutableStateOf<String?>(null) }
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current

    val hPager = rememberPagerState { sessions.size.coerceAtLeast(1) }
    val vPager = rememberPagerState { 2 }
    val current = sessions.getOrNull(hPager.currentPage)

    fun onCommand(cmd: WatchCommand) {
        repo.sendCommand(cmd)
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        feedback = "✓ 已发送"
    }

    // 通知栏一键 Allow/Reject 投递到当前仓库
    DisposableEffect(repo) {
        CommandBus.sink = { repo.sendCommand(it) }
        onDispose { CommandBus.sink = null }
    }

    LaunchedEffect(feedback) {
        if (feedback != null) {
            delay(1200)
            feedback = null
        }
    }

    // 全局状态跃变：通知 + 震动（当前会话加触觉反馈）；回到 WORKING 撤通知
    var prevStatuses by remember { mutableStateOf<Map<String, SessionStatus>>(emptyMap()) }
    LaunchedEffect(sessions) {
        val next = sessions.associate { it.sessionId to it.status }
        next.forEach { (sid, st) ->
            val old = prevStatuses[sid] ?: return@forEach
            if (old == st) return@forEach
            val s = sessions.firstOrNull { it.sessionId == sid } ?: return@forEach
            when (st) {
                SessionStatus.WAITING, SessionStatus.ERROR, SessionStatus.DONE -> {
                    Notifier.notify(context, s)
                    if (s.sessionId == current?.sessionId) {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    }
                }
                SessionStatus.WORKING -> Notifier.cancel(context, sid)
            }
        }
        prevStatuses = next
    }

    // 通知深链：直达对应 Session 的 W1
    LaunchedEffect(pendingSid, sessions) {
        if (pendingSid == null) return@LaunchedEffect
        val idx = sessions.indexOfFirst { it.sessionId == pendingSid }
        if (idx >= 0) {
            hPager.scrollToPage(idx)
            vPager.scrollToPage(0)
            onSidConsumed()
        }
    }

    // 会话列表收缩时夹住页码
    LaunchedEffect(sessions.size) {
        if (hPager.currentPage >= sessions.size && sessions.isNotEmpty()) {
            hPager.scrollToPage(sessions.size - 1)
        }
    }

    // 返回层级：W2时间线 -> W1会话卡 -> W4总览 -> 退出（详情页右滑可回"列表"）
    BackHandler(enabled = screen != Screen.Overview) {
        when {
            screen != Screen.Home -> screen = when (val s = screen) {
                is Screen.More -> Screen.Menu(s.sid)
                else -> Screen.Home
            }
            vPager.currentPage == 1 -> scope.launch { vPager.animateScrollToPage(0) }
            else -> screen = Screen.Overview
        }
    }

    Box(Modifier.fillMaxSize()) {
        // ---------- Home：W1(左右切 Session) + W2(上下看事件) ----------
        // beyondViewportPageCount=1：预组合相邻页，消除切页/上滑进时间线时的首帧组合卡顿
        VerticalPager(state = vPager, modifier = Modifier.fillMaxSize(), beyondViewportPageCount = 1) { vPage ->
            if (vPage == 0) {
                if (sessions.isEmpty()) {
                    EmptyHome(connected, onOverview = { screen = Screen.Overview })
                } else {
                    HorizontalPager(state = hPager, beyondViewportPageCount = 1) { hPage ->
                        val s = sessions.getOrNull(hPage) ?: return@HorizontalPager
                        Box(
                            Modifier
                                .fillMaxSize()
                                .combinedClickable(
                                    onClick = { screen = Screen.Menu(s.sessionId) },
                                    onLongClick = {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        screen = Screen.Overview
                                    },
                                )
                        ) {
                            W1Card(
                                s = s,
                                events = timelines[s.sessionId] ?: emptyList(),
                                onCommand = ::onCommand,
                                onOpenTimeline = { scope.launch { vPager.animateScrollToPage(1) } },
                            )
                        }
                    }
                }
            } else {
                val s = current ?: return@VerticalPager
                // W2 横滑返回 W1（垂直方向留给 VerticalPager 翻页）
                val accX = remember { floatArrayOf(0f) }
                Box(
                    Modifier
                        .fillMaxSize()
                        .pointerInput(Unit) {
                            detectHorizontalDragGestures(
                                onHorizontalDrag = { _, dragAmount -> accX[0] += dragAmount },
                                onDragEnd = {
                                    if (accX[0] > 40.dp.toPx()) scope.launch { vPager.animateScrollToPage(0) }
                                    accX[0] = 0f
                                },
                            )
                        },
                ) {
                    W2Timeline(s, timelines[s.sessionId] ?: emptyList())
                }
            }
        }

        if (vPager.currentPage == 0 && sessions.isNotEmpty()) {
            TimeText(modifier = Modifier.align(Alignment.TopCenter))
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
            ) {
                if (connected) {
                    PaginationDots(sessions.size, hPager.currentPage)
                } else {
                    OfflineChip()
                }
                feedback?.let {
                    Text(it, color = C.done, fontSize = 10.sp)
                }
            }
        } else {
            TimeText(modifier = Modifier.align(Alignment.TopCenter))
        }

        // ---------- 叠加层 ----------
        when (val s = screen) {
            is Screen.Menu -> {
                val session = sessions.firstOrNull { it.sessionId == s.sid }
                if (session == null) screen = Screen.Home
                else W3Menu(
                    s = session,
                    onCommand = ::onCommand,
                    onVoice = { screen = Screen.Voice(session.sessionId) },
                    onMore = { screen = Screen.More(session.sessionId) },
                    onClose = { screen = Screen.Home },
                )
            }
            is Screen.More -> {
                val session = sessions.firstOrNull { it.sessionId == s.sid }
                if (session == null) screen = Screen.Home
                else W3More(
                    s = session,
                    onCommand = ::onCommand,
                    onOpenTimeline = {
                        screen = Screen.Home
                        scope.launch { vPager.animateScrollToPage(1) }
                    },
                    onBack = { screen = Screen.Menu(s.sid) },
                )
            }
            Screen.Overview -> {
                W4Overview(
                    sessions = sessions,
                    onSelect = { selected ->
                        screen = Screen.Home
                        scope.launch {
                            vPager.scrollToPage(0)
                            val idx = sessions.indexOfFirst { it.sessionId == selected.sessionId }
                            if (idx >= 0) hPager.scrollToPage(idx)
                        }
                    },
                    onSettings = { screen = Screen.Settings },
                )
            }
            is Screen.Voice -> {
                val session = sessions.firstOrNull { it.sessionId == s.sid }
                if (session == null) screen = Screen.Home
                else W5Voice(
                    s = session,
                    onCommand = ::onCommand,
                    onDone = { screen = Screen.Home },
                )
            }
            Screen.Settings -> {
                SettingsScreen(
                    mode = mode,
                    host = host,
                    token = token,
                    connected = connected,
                    onSave = onSaveSettings,
                )
            }
            Screen.Home -> {}
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun EmptyHome(connected: Boolean, onOverview: () -> Unit) {
    Box(
        Modifier
            .fillMaxSize()
            .combinedClickable(onClick = onOverview, onLongClick = onOverview),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                if (connected) "暂无会话" else "未连接",
                color = C.textPrimary,
                fontSize = 14.sp,
            )
            Text(
                if (connected) "点按进入总览" else "点按进入总览 · 设置",
                color = C.textSecondary,
                fontSize = 11.sp,
            )
        }
    }
}
