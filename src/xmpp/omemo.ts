/** OMEMO al quedar en línea: init + publicación de la identidad propia (o baja si está desactivado). */
import type { Client } from '@xmpp/xml';
import { Omemo } from '@/xmpp/xep-0384';
import { connection } from '@/xmpp/session';
import { startOmemo2 } from '@/xmpp/omemo2';

const OMEMO_PUBLISH_RETRY_BASE_MS = 5000;
const OMEMO_PUBLISH_RETRY_MAX_ATTEMPTS = 6; // ~5s..80s, luego se abandona hasta la próxima conexión

/**
 * Publica el bundle y la device list propios tras conectar, con reintento.
 *
 * Antes esto era un `.catch` mudo (solo console.error): si publishBundle o
 * publishDeviceList fallaban (timeout, error del servidor), el device local
 * seguía generando claves y cifrando mensajes con su deviceId, pero ningún
 * otro cliente podía verlo — nunca apareció en la device list del servidor
 * ni tuvo bundle descargable. El síntoma visible era "los mensajes propios
 * no se leen entre clientes", con SenderNotFound del lado receptor. El
 * reintento cubre fallos transitorios de red al conectar; si sigue fallando
 * tras el tope de intentos, se abandona hasta la próxima reconexión en vez
 * de reintentar para siempre.
 */
async function publishOwnOmemoIdentityWithRetry(attempt = 0): Promise<void> {
  try {
    await Omemo.publishBundle();
    // Advertise the device only after its bundle is available. Strict
    // clients may fetch immediately on a device-list notification.
    await Omemo.publishDeviceList();
  } catch (err) {
    if (attempt >= OMEMO_PUBLISH_RETRY_MAX_ATTEMPTS || !connection.isUsable()) {
      console.error(
        `[OMEMO] Failed to publish own identity after ${attempt + 1} attempt(s), giving up until next reconnect`,
        err,
      );
      return;
    }
    const delay = OMEMO_PUBLISH_RETRY_BASE_MS * 2 ** attempt;
    console.warn(`[OMEMO] Failed to publish own identity, retrying in ${delay}ms`, err);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (!connection.isUsable()) return;
    await publishOwnOmemoIdentityWithRetry(attempt + 1);
  }
}

/** Igual que la identidad legacy: publica bundle + device list OMEMO 2, con reintento acotado. */
async function startOmemo2WithRetry(jid: string, attempt = 0): Promise<void> {
  try {
    await startOmemo2(jid);
  } catch (err) {
    if (attempt >= 3 || !connection.isUsable()) {
      console.error('[OMEMO2] Failed to publish own identity, giving up until next reconnect', err);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, OMEMO_PUBLISH_RETRY_BASE_MS * 2 ** attempt));
    if (connection.isUsable()) await startOmemo2WithRetry(jid, attempt + 1);
  }
}

export function initOmemoOnOnline(jid: string, client: Client, enabled: boolean) {
  // OMEMO legacy es Android-only (módulo nativo). En el resto de plataformas
  // (web/Tauri, iOS) no hay módulo nativo: se salta el init legacy sin error,
  // y la cripto corre por OMEMO 2 (puente sqlite/keyring).
  const legacySupported = Omemo.isSupported();
  if (enabled) {
    void startOmemo2WithRetry(jid);
    if (!legacySupported) return;
    Omemo.init(jid, client, true)
      .then(async () => {
        await publishOwnOmemoIdentityWithRetry();
      })
      .catch((err) => {
        console.error('[OMEMO] Failed to initialize OMEMO on online', err);
      });
  } else {
    if (!legacySupported) return;
    Omemo.init(jid, client, false)
      .then(() => Omemo.removeOwnDevice())
      .catch((error) => console.error('[OMEMO] Failed to remove disabled device', error));
  }
}
