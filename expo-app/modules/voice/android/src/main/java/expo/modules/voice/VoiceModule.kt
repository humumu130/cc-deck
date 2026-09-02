package expo.modules.voice

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// 语音输入：android.speech.SpeechRecognizer 实时转文字（partial 增量下发，松手 stopListening 后 final）。
// 两个坑：
// 1) 识别器必须主线程创建/启动——Expo 模块函数在后台线程跑，直接用则回调静默不触发（表现为按住毫无反应）。
// 2) 国产 ROM 常无默认识别服务（isRecognitionAvailable 只查默认），且 GMS 残留的 Google 组件可能
//    绑得上但一个回调都不出。方案：服务链（系统默认优先 → 枚举 RecognitionService，Google 次之），
//    单个服务 2.5s 无任何回调或启动即报 5/8，自动销毁换下一个；全部失败回 error -3。
// 错误码约定：-1 startListening 异常；-2 本机无任何识别服务；-3 服务链全部无响应。
class VoiceModule : Module() {
  private var recognizer: SpeechRecognizer? = null
  private val main = Handler(Looper.getMainLooper())
  private var chain: List<ComponentName> = emptyList()
  private var chainIdx = 0
  private var holding = false
  private var sawAudio = false

  private fun enumerate(ctx: Context): List<ComponentName> {
    return runCatching {
      ctx.packageManager.queryIntentServices(Intent(SERVICE_ACTION), 0)
        .orEmpty()
        .mapNotNull { ri -> ri.serviceInfo?.let { ComponentName(it.packageName, it.name) } }
        .sortedBy { !it.packageName.contains("google") }
    }.getOrDefault(emptyList())
  }

  private fun buildChain(ctx: Context): List<ComponentName> {
    val def = runCatching {
      // Settings.Secure.VOICE_RECOGNITION_SERVICE 是隐藏常量，这里用字面量
      Settings.Secure.getString(ctx.contentResolver, "voice_recognition_service")
        ?.let { ComponentName.unflattenFromString(it) }
    }.getOrNull()
    val rest = enumerate(ctx).filter { it != def }
    val list = (if (def != null) listOf(def) else emptyList()) + rest
    val lg = lastGood
    return if (lg != null) list.sortedBy { it != lg } else list
  }

  private val listener = object : RecognitionListener {
    override fun onReadyForSpeech(params: Bundle?) { sawAudio = true }
    override fun onBeginningOfSpeech() { sawAudio = true }
    override fun onRmsChanged(rmsdB: Float) { sawAudio = true }
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEndOfSpeech() {}
    override fun onError(error: Int) {
      // 出声前就报 5(CLIENT)/8(BUSY)：多半是该服务本身坏的，静默换下一个
      if (!sawAudio && (error == 5 || error == 8) && chainIdx < chain.size - 1 && holding) {
        nextAttempt()
        return
      }
      sendEvent("onVoiceEvent", mapOf("type" to "error", "code" to error))
    }
    override fun onResults(results: Bundle?) {
      val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
      sendEvent("onVoiceEvent", mapOf("type" to "final", "text" to text))
    }
    override fun onPartialResults(partialResults: Bundle?) {
      sawAudio = true
      val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
      if (text.isNotEmpty()) {
        lastGood = chain.getOrNull(chainIdx)
        sendEvent("onVoiceEvent", mapOf("type" to "partial", "text" to text))
      }
    }
    override fun onEvent(eventType: Int, params: Bundle?) {}
  }

  private fun startAttempt() {
    val ctx = appContext.reactContext
    val comp = chain.getOrNull(chainIdx)
    if (ctx == null || comp == null) {
      sendEvent("onVoiceEvent", mapOf("type" to "error", "code" to if (chain.isEmpty()) -2 else -3))
      return
    }
    sawAudio = false
    val r = runCatching { SpeechRecognizer.createSpeechRecognizer(ctx, comp) }.getOrNull() ?: run {
      nextAttempt()
      return
    }
    recognizer = r
    r.setRecognitionListener(listener)
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      // 长句听写模式：部分服务在此模式下更倾向连续输出 partial
      putExtra("android.speech.extra.DICTATION_MODE", true)
    }
    runCatching { r.startListening(intent) }
      .onFailure { sendEvent("onVoiceEvent", mapOf("type" to "error", "code" to -1)) }
    // 无回调 watchdog：绑上但全静默的服务（GMS 残留典型症状）在此换下一个
    main.postDelayed({
      if (holding && !sawAudio) nextAttempt()
    }, 2500)
  }

  private fun nextAttempt() {
    runCatching { recognizer?.destroy() }
    recognizer = null
    chainIdx++
    startAttempt()
  }

  override fun definition() = ModuleDefinition {
    Name("Voice")

    Events("onVoiceEvent")

    OnDestroy {
      main.post {
        holding = false
        runCatching { recognizer?.destroy() }
        recognizer = null
      }
    }

    AsyncFunction("available") { promise: expo.modules.kotlin.Promise ->
      val ctx = appContext.reactContext
      if (ctx == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      // 枚举有 IO，丢后台线程，结果回主 promise
      Thread {
        val ok = runCatching { buildChain(ctx).isNotEmpty() }.getOrDefault(false)
        promise.resolve(ok)
      }.start()
    }

    Function("start") {
      val ctx = appContext.reactContext ?: return@Function null
      main.post {
        runCatching { recognizer?.destroy() }
        recognizer = null
        chain = buildChain(ctx)
        chainIdx = 0
        holding = true
        startAttempt()
      }
      null
    }

    // 松手：收尾并等 final（stopListening 后服务通常几百 ms 内给最终结果）
    Function("stop") {
      main.post {
        holding = false
        runCatching { recognizer?.stopListening() }
      }
      null
    }

    Function("cancel") {
      main.post {
        holding = false
        runCatching { recognizer?.destroy() }
        recognizer = null
      }
      null
    }
  }

  companion object {
    private const val SERVICE_ACTION = "android.speech.RecognitionService"
    // 进程级记忆：上次真正出过转写文字的服务，下次优先（跳过已证实坏掉的服务）
    private var lastGood: ComponentName? = null
  }
}
