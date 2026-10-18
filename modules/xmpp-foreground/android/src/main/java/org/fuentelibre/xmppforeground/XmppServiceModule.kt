package org.fuentelibre.xmppforeground

import android.app.ForegroundServiceStartNotAllowedException
import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class XmppServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("xmpp_no_context", "React context not available", null)

  override fun definition() = ModuleDefinition {
    Name("XmppServiceModule")

    AsyncFunction("startService") { jid: String -> start(jid) }

    AsyncFunction("updateNotification") { jid: String -> start(jid) }

    AsyncFunction("stopService") {
      try {
        context.stopService(Intent(context, XmppForegroundService::class.java))
        true
      } catch (error: Throwable) {
        throw CodedException("xmpp_foreground_stop_failed", error.message, error)
      }
    }
  }

  private fun start(jid: String): Boolean {
    try {
      val intent = Intent(context, XmppForegroundService::class.java).apply {
        putExtra("jid", jid)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      return true
    } catch (error: Throwable) {
      // Android 12+: arrancar un FGS desde background está prohibido y lanza
      // ForegroundServiceStartNotAllowedException. No es un fallo que el JS
      // pueda resolver reintentando -- el servicio se levanta solo cuando la
      // app vuelve a foreground -- así que devolvemos false en vez de
      // rechazar, para no alimentar bucles de reintento.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        error is ForegroundServiceStartNotAllowedException
      ) {
        return false
      }
      throw CodedException("xmpp_foreground_start_failed", error.message, error)
    }
  }
}
