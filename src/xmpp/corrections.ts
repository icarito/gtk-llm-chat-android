/** XEP-0308: correcciones entrantes que resuelven (o hacen crecer) un mensaje. */
import type { XmppMessage } from '@/types/xmpp';
import { isEncrypted } from '@/xmpp/encryption';
import { dismissNotificationForJid } from '@/xmpp/notifications';
import { XmppHistory } from '@/xmpp/XmppHistory';
import { removePendingActionsByMessage } from '@/xmpp/actions';
import { messages } from '@/xmpp/store';

/**
 * XEP-0308 correction resolving a pending question: clears its card from
 * memory and from the local cache, and dismisses any notification it may
 * have posted. Server-authoritative — unlike the own-carbon heuristic
 * (expireMatchingQuickResponses), this carries the real replaceId so it
 * works no matter which question it resolves, not just the newest one.
 */
export function applyIncomingCorrection(
  conversationJid: string,
  replaceId: string,
  body: string,
  timestamp: string,
  encryptionStatus?: XmppMessage['encryptionStatus'],
) {
  removePendingActionsByMessage(conversationJid, replaceId);
  // El timestamp original (llegada del placeholder/pregunta) se sustituye por
  // el de la corrección: es lo que resuelve el turno y lo que gtk/Gajim
  // muestran como hora del mensaje. Sin esto, un mensaje resuelto minutos
  // después seguía ordenado y mostrado con la hora de su versión inicial.
  XmppHistory.applyCorrectionByStanzaId(
    conversationJid, replaceId, body, timestamp, isEncrypted(encryptionStatus),
  ).catch(() => {});
  dismissNotificationForJid(conversationJid).catch(() => {});
  // La burbuja visible también: sin esto la corrección solo llega al SQLite y
  // el streaming del gateway (burbuja única XEP-0308 que crece) no se ve hasta
  // recargar el historial. `correctedAtMs` alimenta la afordancia "en curso".
  const existing = messages.getConversation(conversationJid);
  const idx = existing.findIndex((m) => m.id === replaceId);
  if (idx < 0) {
    // Alineado a GTK 2026-07-20 (_on_llm_response_correction: "una corrección
    // sin widget correlacionado se ignora, nunca debe sobrescribir por
    // aproximación"). Antes esto sintetizaba un mensaje nuevo con el body de
    // la corrección — pensado para "la app se abrió a mitad de turno", pero
    // ese mismo código corre para CUALQUIER corrección sin match, incluidos
    // carbons de otra conversación que esta sesión nunca cargó
    // (ver el call site vía forwarded carbon más abajo): un body de
    // corrección aislado, sin el mensaje original, sin card, sin contexto —
    // un mensaje fantasma. El caso legítimo que la síntesis pretendía cubrir
    // ya lo resuelve MAM/historial al reabrir el chat: el mensaje original
    // (ya resuelto) llega completo desde el servidor, no como un fragmento.
    return;
  }
  const updated = [...existing];
  updated[idx] = {
    ...updated[idx],
    body,
    timestamp,
    quickResponses: undefined,
    commands: undefined,
    correctedAtMs: Date.now(),
    wasEncrypted: isEncrypted(encryptionStatus) || updated[idx]?.wasEncrypted,
    encryptionStatus: encryptionStatus ?? updated[idx]?.encryptionStatus,
  };
  messages.setConversation(conversationJid, updated);
}
