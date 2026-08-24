package com.humumu.ccwatch

import android.os.Build
import android.os.Bundle
import android.view.View

import androidx.core.view.OnApplyWindowInsetsListener
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
    installKbInsetsEmitter()
  }

  // bridgeless + edge-to-edge 下 ReactRootView 的 keyboardDidShow 不再触发（Android 16 实测），
  // 把 IME 键盘高度（转 dp，RN 样式单位）发给 JS（src/kb.ts 消费）。
  // insets listener 可能被 RN/expo 的 edge-to-edge 设置覆盖或截断分发，
  // 用 OnGlobalLayoutListener + rootWindowInsets 兜底，直接从 decorView 读。
  private fun installKbInsetsEmitter() {
    var last = -1
    val emit: (Int) -> Unit = { px ->
      val dp = (px / resources.displayMetrics.density).toInt()
      if (dp != last) {
        last = dp
        val ctx = (application as? MainApplication)?.reactHost?.currentReactContext
        ctx
          ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          ?.emit("kbInsets", Arguments.createMap().apply { putInt("height", dp) })
      }
    }
    val listener = OnApplyWindowInsetsListener { _, insets ->
      emit(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
      insets
    }
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView, listener)
    findViewById<View>(android.R.id.content)?.let {
      ViewCompat.setOnApplyWindowInsetsListener(it, listener)
    }
    window.decorView.viewTreeObserver.addOnGlobalLayoutListener {
      val ime = if (Build.VERSION.SDK_INT >= 30) {
        window.decorView.rootWindowInsets
          ?.getInsets(android.view.WindowInsets.Type.ime())?.bottom ?: 0
      } else {
        val r = android.graphics.Rect()
        window.decorView.getWindowVisibleDisplayFrame(r)
        (window.decorView.height - r.bottom).coerceAtLeast(0)
      }
      emit(ime)
    }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
