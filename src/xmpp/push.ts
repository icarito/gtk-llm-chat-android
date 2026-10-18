/** XEP-0357: registro de push (Expo) tras conectar. */
import { xml } from '@xmpp/client';
import { getStoredExpoPushToken } from '@/xmpp/notifications';
import { PushStatus } from '@/xmpp/pushStatus';
import { EXPO_PUSH_SERVICE_JID, PUSH_NS } from '@/xmpp/ns';
import { session, usableClient } from '@/xmpp/session';

const pushLog = globalThis.console;

export async function enableExpoPushIfAvailable(): Promise<void> {
  // Capturamos el cliente ANTES del await: si mientras tanto la conexión se cae,
  // el auto-retry pone xmppClient a null y leer la global después revienta con
  // "Cannot read property 'iqCaller' of null" en cada reintento.
  const activeClient = usableClient();
  if (!activeClient) return;

  const token = await getStoredExpoPushToken();
  if (!token) {
    PushStatus.update({ registration: 'idle', error: null });
    pushLog.warn('[xmpp-push] No stored Expo push token yet; skipping XEP-0357 registration');
    return;
  }
  if (session.client !== activeClient) return; // reconectamos durante el await

  PushStatus.update({ registration: 'pending', error: null });
  await activeClient.iqCaller.request(
    xml(
      'iq',
      { type: 'set', id: `push-enable-${Date.now()}` },
      xml('enable', {
        xmlns: PUSH_NS,
        jid: EXPO_PUSH_SERVICE_JID,
        node: token,
      }),
    ),
    15000,
  );
  PushStatus.update({ registration: 'registered', error: null });
  pushLog.warn(`[xmpp-push] XEP-0357 registered with ${EXPO_PUSH_SERVICE_JID}`);
}
/** Fallo del registro: lo refleja en PushStatus y en el log. */
export function reportPushFailure(error: unknown) {
  PushStatus.update({
    registration: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
  pushLog.warn('[xmpp-push] XEP-0357 registration failed', error);
}
