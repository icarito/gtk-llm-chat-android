import { AppState, NativeModules } from 'react-native';

const { XmppServiceModule } = NativeModules;

/**
 * Android 12+ (API 31) prohíbe startForegroundService() desde background: lanza
 * ForegroundServiceStartNotAllowedException y el sistema la registra como
 * "Background started FGS: Disallowed".
 *
 * Como esto se llama en cada 'online' del cliente, una reconexión con la app en
 * segundo plano se volvía un bucle de intentos denegados. Si ya estamos en
 * background no hay nada que hacer: el servicio se levantará cuando el usuario
 * vuelva a abrir la app (el listener de AppState llama a reconnectIfNeeded, que
 * termina en 'online' y por tanto aquí, esta vez en foreground).
 */
function startForegroundService(jid: string): Promise<void> {
  if (!XmppServiceModule) return Promise.resolve();
  if (AppState.currentState !== 'active') return Promise.resolve();
  return XmppServiceModule.startService(jid).then(() => undefined);
}

function stopForegroundService(): Promise<void> {
  if (XmppServiceModule) {
    return XmppServiceModule.stopService().then(() => undefined);
  }
  return Promise.resolve();
}

function updateNotification(jid: string): Promise<void> {
  if (XmppServiceModule) {
    return XmppServiceModule.updateNotification(jid).then(() => undefined);
  }
  return Promise.resolve();
}

export const ForegroundService = {
  start: startForegroundService,
  stop: stopForegroundService,
  update: updateNotification,
};
