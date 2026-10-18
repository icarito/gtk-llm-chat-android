/**
 * XEP-0199: watchdog de la conexión. Sólo es un DISPARADOR: cuando el ping
 * muere avisa por `onDead` y la recuperación la decide la política única de
 * reconexión (connection.ts).
 */
import { xml } from '@xmpp/client';
import { session } from '@/xmpp/session';

let pingTimer: ReturnType<typeof setInterval> | null = null;
const PING_INTERVAL_MS = 55000;

export async function pingServer(jid: string, timeoutMs = 15000): Promise<void> {
  const client = session.client;
  if (!client) throw new Error('XMPP not connected');
  await client.iqCaller.request(
    xml('iq', { type: 'get', to: jid, id: `ping-${Date.now()}` }, xml('ping', { xmlns: 'urn:xmpp:ping' })),
    timeoutMs,
  );
}

/** `onDead(client)` sólo se invoca si el cliente que falló sigue siendo el activo. */
export function startPing(jid: string, onDead: (dead: NonNullable<typeof session.client>) => void | Promise<void>) {
  stopPing();
  pingTimer = setInterval(async () => {
    // Capturamos el cliente: durante el await del ping la conexión puede
    // cambiar, y tumbar al cliente NUEVO por el fallo del viejo deja a medio
    // servicio hablándole a un cliente ya nulo.
    const activeClient = session.client;
    if (!activeClient) return;
    try {
      await pingServer(jid);
    } catch {
      if (session.client !== activeClient) return; // ya reconectamos
      await onDead(activeClient);
    }
  }, PING_INTERVAL_MS);
}

export function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}
