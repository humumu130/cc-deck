package expo.modules.voice

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// 语音输入：android.speech.SpeechRecognizer 实时转文字（partial 增量下发，松手 stopListening 后 final）。
// 无识别服务的设备（无 GMS 的 ROM / VM）上 available() 返回 false，JS 侧提示，不抛错。
// 国产 ROM 常有识别服务但未设为系统默认（isRecognitionAvailable 只查默认）：
// 枚举 android.speech.RecognitionService 意图的服务显式绑定（优先 Google）。
class VoiceModule : Module() {
  private var recognizer: SpeechRecognizer? = null

  private fun pickService(ctx: Context): ComponentName? {
    return runCatching {
      val list = ctx.packageManager.queryIntentServices(Intent(SERVICE_ACTION), 0)
      if (list.isNullOrEmpty()) return@runCatching null
      val ri = list.firstOrNull { it.serviceInfo?.packageName?.contains("google") == true } ?: list[0]
      ComponentName(ri.serviceInfo.packageName, ri.serviceInfo.name)
    }.getOrNull()
  }

  override fun definition() = ModuleDefinition {
    Name("Voice")

    Events("onVoiceEvent")

    OnDestroy {
      runCatching { recognizer?.destroy() }
      recognizer = null
    }

    AsyncFunction("available") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      runCatching {
        SpeechRecognizer.isRecognitionAvailable(ctx) || pickService(ctx) != null
      }.getOrDefault(false)
    }

    Function("start") {
      val ctx = appContext.reactContext ?: return@Function null
      runCatching { recognizer?.destroy() }
      recognizer = null
      val r = try {
        val comp = pickService(ctx)
        if (comp != null) SpeechRecognizer.createSpeechRecognizer(ctx, comp)
        else SpeechRecognizer.createSpeechRecognizer(ctx)
      } catch (e: Exception) {
        null
      } ?: return@Function null
      recognizer = r
      r.setRecognitionListener(object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onError(error: Int) {
          sendEvent("onVoiceEvent", mapOf("type" to "error", "code" to error))
        }
        override fun onResults(results: Bundle?) {
          val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
          sendEvent("onVoiceEvent", mapOf("type" to "final", "text" to text))
        }
        override fun onPartialResults(partialResults: Bundle?) {
          val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
          if (text.isNotEmpty()) sendEvent("onVoiceEvent", mapOf("type" to "partial", "text" to text))
        }
        override fun onEvent(eventType: Int, params: Bundle?) {}
      })
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        // 长句听写模式：部分服务在此模式下更倾向连续输出 partial
        putExtra("android.speech.extra.DICTATION_MODE", true)
      }
      runCatching { r.startListening(intent) }
        .onFailure { sendEvent("onVoiceEvent", mapOf("type" to "error", "code" to -1)) }
    }

    // 松手：收尾并等 final（stopListening 后服务通常几百 ms 内给最终结果）
    Function("stop") {
      runCatching { recognizer?.stopListening() }
    }

    Function("cancel") {
      runCatching { recognizer?.destroy() }
      recognizer = null
    }
  }

  companion object {
    private const val SERVICE_ACTION = "android.speech.RecognitionService"
  }
}
