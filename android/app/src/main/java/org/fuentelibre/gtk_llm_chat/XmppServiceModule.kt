package org.fuentelibre.gtk_llm_chat

import android.app.ForegroundServiceStartNotAllowedException
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class XmppServiceModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "XmppServiceModule"

  @ReactMethod
  fun startService(jid: String, promise: Promise) {
    try {
      val intent = serviceIntent(jid)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.startForegroundService(intent)
      } else {
        reactContext.startService(intent)
      }
      promise.resolve(true)
    } catch (error: Throwable) {
      // Android 12+: arrancar un FGS desde background está prohibido y lanza
      // ForegroundServiceStartNotAllowedException. No es un fallo que el JS
      // pueda resolver reintentando -- el servicio se levanta solo cuando la
      // app vuelve a foreground -- así que resolvemos en falso en vez de
      // rechazar, para no alimentar bucles de reintento.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        error is ForegroundServiceStartNotAllowedException
      ) {
        promise.resolve(false)
      } else {
        promise.reject("xmpp_foreground_start_failed", error)
      }
    }
  }

  @ReactMethod
  fun updateNotification(jid: String, promise: Promise) {
    startService(jid, promise)
  }

  @ReactMethod
  fun stopService(promise: Promise) {
    try {
      reactContext.stopService(Intent(reactContext, XmppForegroundService::class.java))
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject("xmpp_foreground_stop_failed", error)
    }
  }

  private fun serviceIntent(jid: String): Intent =
    Intent(reactContext, XmppForegroundService::class.java).apply {
      putExtra("jid", jid)
    }
}
