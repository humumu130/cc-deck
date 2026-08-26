package com.humumu.ccwatch.ui

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import com.humumu.ccwatch.protocol.SessionState
import com.humumu.ccwatch.protocol.WatchCommand
import java.util.UUID

private val presets = listOf("运行测试", "继续", "重试", "解释当前进度")

/**
 * W5 · 语音输入（规范 §10）：默认目标永远是当前 Session。
 * 无语音识别能力时（本机无 GMS 常见）降级为快捷指令，界面仍走 Recognized→Sending 阶段。
 */
@Composable
fun W5Voice(
    s: SessionState,
    onCommand: (WatchCommand) -> Unit,
    onDone: () -> Unit,
) {
    val context = LocalContext.current
    var stage by remember { mutableStateOf("listen") } // listen | preview | sending
    var text by remember { mutableStateOf("") }
    val srAvailable = remember { SpeechRecognizer.isRecognitionAvailable(context) }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val r = res.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (res.resultCode == Activity.RESULT_OK && !r.isNullOrBlank()) {
            text = r
            stage = "preview"
        } else {
            stage = "listen"
        }
    }

    LaunchedEffect(Unit) {
        if (srAvailable) {
            launcher.launch(
                Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
                    putExtra(RecognizerIntent.EXTRA_PROMPT, "对当前 Session 说话")
                }
            )
        }
    }

    fun send() {
        stage = "sending"
        onCommand(WatchCommand.Message(UUID.randomUUID().toString(), s.sessionId, text))
        onDone()
    }

    // 全屏底色 + 拦截空白点击（防穿透到下层 W1）
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = Modifier
            .fillMaxSize()
            .background(C.bg)
            .pointerInput(Unit) { detectTapGestures { } }
            .padding(horizontal = 24.dp),
    ) {
        when (stage) {
            "listen" -> {
                StatusIcon(s.status, 20.dp)
                Spacer(Modifier.height(6.dp))
                Text("语音输入", color = C.textPrimary, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(4.dp))
                Text(
                    if (srAvailable) "Listening…\n（说出指令）" else "此设备无语音识别\n使用快捷指令",
                    color = C.textSecondary,
                    fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(10.dp))
                if (!srAvailable) {
                    presets.forEach { p ->
                        MoreItem(p, color = C.primary) {
                            text = p
                            stage = "preview"
                        }
                        Spacer(Modifier.height(2.dp))
                    }
                }
            }
            "preview" -> {
                Text("请确认发送", color = C.primary, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(6.dp))
                Text(
                    "“$text”",
                    color = C.textPrimary,
                    fontSize = 13.sp,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    RoundButton("取消", C.textSecondary, 54.dp) { onDone() }
                    RoundButton("发送", C.primary, 54.dp) { send() }
                }
            }
            "sending" -> {
                Text("发送中…", color = C.textSecondary, fontSize = 12.sp)
            }
        }
    }
}
