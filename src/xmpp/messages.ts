/** Mensajes en memoria (store) y envío saliente (texto, reintento). */
import { xml } from '@xmpp/client';
import type { XmppMessage } from '@/types/xmpp';
import { isEncrypted } from '@/xmpp/encryption';
import { isNotificationGraceActive, notifyXmppMessage } from '@/xmpp/notifications';
import type { Element } from '@xmpp/xml';
import { Omemo } from '@/xmpp/xep-0384';
import { getOmemo2 } from '@/xmpp/omemo2';
import { omemoRoomRecipients } from '@/xmpp/muc';
import { XmppHistory } from '@/xmpp/XmppHistory';
import { expireMatchingQuickResponses, resolveApprovalActionsFromOwnMessage } from '@/xmpp/actions';
import { CHAT_STATES_NS } from '@/xmpp/ns';
import { session, usableClient } from '@/xmpp/session';
import { contacts, messages, rooms } from '@/xmpp/store';
import { resolveTargetId } from '@/xmpp/annotations';
import { buildReply, NS_REPLY } from '@/xmpp/xep/reply';
import type { HistoryExtra } from '@/xmpp/XmppHistory';

/** Reemplaza (inmutable) el mensaje `id` saliente de la conversación `to`. */
function patchOutbound(to: string, id: string, patch: Partial<XmppMessage>) {
  const existing = messages.getConversation(to);
  const idx = existing.findIndex((m) => m.id === id && m.direction === 'out');
  if (idx < 0) return;
  const updated = [...existing];
  updated[idx] = { ...updated[idx], ...patch };
  messages.setConversation(to, updated);
}

/** Marca un mensaje saliente como enviado/fallido y notifica a la UI. */
export function updateOutboundSendState(
  to: string,
  id: string,
  sendState: 'pending' | 'sent' | 'failed',
) {
  patchOutbound(to, id, { sendState });
}

export function updateOutboundEncryptionStatus(
  to: string,
  id: string,
  encryptionStatus: XmppMessage['encryptionStatus'],
) {
  patchOutbound(to, id, { wasEncrypted: isEncrypted(encryptionStatus), encryptionStatus });
}

/**
 * Cifrado saliente por prioridad: OMEMO 2 (si el contacto tiene dispositivos
 * OMEMO 2 y el cifrado está activo para él) > OMEMO legacy (Android; falla
 * cerrado si no hay dispositivos) > null = texto plano. El llamador marca el
 * estado visible ('none') cuando devuelve null.
 * Salas: OMEMO 2 sólo si la sala es no anónima (ver omemoRoomRecipients); si no,
 * texto plano, nunca error. Con motor OMEMO 2 no se usa el legacy en salas.
 */
async function encryptOutbound(
  to: string,
  id: string,
  body: string,
  type: 'chat' | 'groupchat',
): Promise<{ children: Element[]; status: 'omemo2' | 'omemo' } | null> {
  if (type === 'chat') {
    const engine = getOmemo2();
    const children = engine ? await engine.encryptOutgoing(to, id, body) : null;
    if (children) return { children, status: 'omemo2' };
  } else {
    const engine = getOmemo2();
    if (engine) {
      const peers = await omemoRoomRecipients(to);
      const res = peers ? await engine.encryptOutgoingGroup(to, peers, id, body) : null;
      const room = rooms.get(to);
      if (room) {
        const reason = res ? undefined
          : !engine.isEnabledFor(to) ? 'cifrado desactivado'
          : room.nonAnonymous ? 'nadie con OMEMO 2' : room.omemoUnavailableReason;
        rooms.patch(to, { omemoSkipped: res?.skipped.length ?? 0, omemoUnavailableReason: reason });
      }
      return res ? { children: res.children, status: 'omemo2' } : null;
    }
  }
  const legacyOn = session.account?.omemoEnabled && Omemo.isEnabled()
    && (type === 'groupchat' || (getOmemo2()?.isEnabledFor(to) ?? true));
  if (!legacyOn) return null;
  const { encryptedXml, wasEncrypted } = await Omemo.encryptMessage(to, body, type === 'groupchat');
  if (!wasEncrypted || !encryptedXml) throw new Error(`No hay dispositivos OMEMO compatibles para ${to}`);
  return {
    children: [
      encryptedXml,
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' }),
      xml('store', { xmlns: 'urn:xmpp:hints' }),
    ],
    status: 'omemo',
  };
}

export function addMessageToMap(msg: XmppMessage, notifyIncoming = true) {
  // Conversations are keyed by the OTHER party, whichever way the message went.
  const key = msg.direction === 'out' ? msg.to : msg.from;
  if (!key) return;
  messages.setConversation(key, [...messages.getConversation(key), msg]);

  if (msg.direction === 'out') {
    expireMatchingQuickResponses(key, msg.body, msg.timestamp);
    resolveApprovalActionsFromOwnMessage(key, msg.body);
  } else if (notifyIncoming && !msg.correctedAtMs && !isNotificationGraceActive()) {
    const contact = contacts.get(msg.from);
    notifyXmppMessage(msg, contact?.name);
  }
}

/** Metadatos XEP-0444/0461/0424/0359 de un mensaje, para persistirlos; undefined si no tiene ninguno. */
export function historyExtra(msg: XmppMessage): HistoryExtra | undefined {
  const extra: HistoryExtra = {
    reactions: msg.reactions,
    replyTo: msg.replyTo,
    retracted: msg.retracted,
    mucStanzaId: msg.stanzaId,
    senderNick: msg.senderNick,
  };
  return Object.values(extra).some(Boolean) ? extra : undefined;
}

/** Respuesta (XEP-0461) a otro mensaje: `id` es el del mensaje citado, `jid` su autor. */
export interface ReplyRef {
  id: string;
  jid: string;
  quotedText?: string;
}

/** Reintenta un mensaje saliente marcado como fallido. */
export async function retryMessage(to: string, id: string): Promise<void> {
  const client = usableClient();
  if (!client) {
    throw new Error('XMPP not connected');
  }
  const msg = messages.getConversation(to)
    .find((m) => m.id === id && m.direction === 'out' && m.sendState === 'failed');
  if (!msg) return;
  updateOutboundSendState(to, id, 'pending');
  try {
    const enc = await encryptOutbound(to, id, msg.body, msg.type === 'groupchat' ? 'groupchat' : 'chat');
    await client.send(xml(
      'message',
      { type: msg.type, to, id },
      ...(enc ? enc.children : [xml('body', {}, msg.body)]),
      xml('active', { xmlns: CHAT_STATES_NS }),
    ));
    const encrypted = enc !== null;
    updateOutboundEncryptionStatus(to, id, enc?.status ?? 'none');
    updateOutboundSendState(to, id, 'sent');
    XmppHistory.recordMessage(
      to, msg.body, 'out', msg.timestamp, null,
      null, null, null, null, null, null, null, null, encrypted,
    ).catch(() => {});
  } catch (error) {
    updateOutboundSendState(to, id, 'failed');
    throw error;
  }
}

export async function sendMessage(
  to: string,
  body: string,
  type: 'chat' | 'groupchat' = 'chat',
  opts: { replyTo?: ReplyRef } = {},
): Promise<string> {
  const client = usableClient();
  if (!client) {
    throw new Error('XMPP not connected');
  }
  const id = `nc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const timestamp = new Date().toISOString();

  if (!body.trim()) throw new Error('No se puede enviar un mensaje vacío');

  const reply = opts.replyTo
    ? { ...opts.replyTo, id: type === 'groupchat' ? resolveTargetId(to, opts.replyTo.id) : opts.replyTo.id }
    : undefined;
  const replyTo = reply
    ? { text: reply.quotedText ?? '', sender: reply.jid, id: reply.id, jid: reply.jid }
    : undefined;
  const senderNick = type === 'groupchat' ? rooms.get(to)?.nick : undefined;

  addMessageToMap({
    id,
    from: session.account?.jid ?? '',
    to,
    type,
    body,
    timestamp,
    direction: 'out',
    isGroup: type === 'groupchat',
    sendState: 'pending',
    replyTo,
    senderNick,
  });
  const extra = historyExtra({ replyTo, senderNick } as XmppMessage);

  try {
    const enc = await encryptOutbound(to, id, body, type);
    if (enc) {
      await client.send(xml(
        'message',
        { type, to, id },
        ...enc.children,
        // XEP-0085: un mensaje con cuerpo implica estado active.
        xml('active', { xmlns: CHAT_STATES_NS }),
        // Cifrado: no hay fallback de cita en claro, pero el <reply> sí viaja.
        ...(reply ? [xml('reply', { xmlns: NS_REPLY, id: reply.id, to: reply.jid })] : []),
      ));
      updateOutboundEncryptionStatus(to, id, enc.status);
      updateOutboundSendState(to, id, 'sent');
      XmppHistory.recordMessage(
        to, body, 'out', timestamp, null,
        null, null, id, null, null, null, null, null, true, extra,
      ).catch(() => {});
      return id;
    }

    const base = reply
      ? buildReply(to, type, body, { targetId: reply.id, targetJid: reply.jid, quotedText: reply.quotedText })
      : xml('message', { type, to }, xml('body', {}, body));
    const stanza = xml(
      'message',
      { ...base.attrs, id },
      ...base.children,
      // XEP-0085: un mensaje con cuerpo implica estado active.
      xml('active', { xmlns: CHAT_STATES_NS }),
    );
    await client.send(stanza);
    if (type === 'chat') updateOutboundEncryptionStatus(to, id, 'none');
    updateOutboundSendState(to, id, 'sent');
  } catch (error) {
    updateOutboundSendState(to, id, 'failed');
    throw error;
  }
  // Cached with no mam_id; the archive copy will be matched onto this row.
  XmppHistory.recordMessage(
    to, body, 'out', timestamp, null,
    null, null, id, null, null, null, null, null, false, extra,
  ).catch(() => {});
  return id;
}

/**
 * XEP-0085 saliente. Best-effort: si no hay conexión, silencio — un estado
 * de chat jamás debe romper nada.
 */
export function sendChatState(to: string, state: 'composing' | 'paused' | 'active'): void {
  const client = usableClient();
  if (!client) return;
  client
    .send(xml('message', { type: 'chat', to }, xml(state, { xmlns: CHAT_STATES_NS })))
    .catch(() => {});
}

export async function sendTyping(to: string) {
  const client = usableClient();
  if (!client) return;
  try {
    await client.send(
      xml('message', { type: 'chat', to }, xml('composing', { xmlns: 'http://jabber.org/protocol/chatstates' })),
    );
  } catch {
    // best effort
  }
}
