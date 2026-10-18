/** Mensajes en memoria (store) y envío saliente (texto, reintento). */
import { xml } from '@xmpp/client';
import type { XmppMessage } from '@/types/xmpp';
import { isNotificationGraceActive, notifyXmppMessage } from '@/xmpp/notifications';
import { Omemo } from '@/xmpp/xep-0384';
import { XmppHistory } from '@/xmpp/XmppHistory';
import { expireMatchingQuickResponses, resolveApprovalActionsFromOwnMessage } from '@/xmpp/actions';
import { CHAT_STATES_NS } from '@/xmpp/ns';
import { session, usableClient } from '@/xmpp/session';
import { contacts, messages } from '@/xmpp/store';

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
  patchOutbound(to, id, { wasEncrypted: encryptionStatus === 'encrypted', encryptionStatus });
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
    let encrypted = false;
    if (session.account?.omemoEnabled && Omemo.isEnabled()) {
      const result = await Omemo.encryptMessage(to, msg.body, msg.type === 'groupchat');
      if (!result.wasEncrypted || !result.encryptedXml) {
        throw new Error(`No hay dispositivos OMEMO compatibles para ${to}`);
      }
      await client.send(xml(
        'message', { type: msg.type, to, id }, result.encryptedXml,
        xml('encryption', {
          xmlns: 'urn:xmpp:eme:0',
          namespace: 'eu.siacs.conversations.axolotl',
          name: 'OMEMO',
        }),
        xml('store', { xmlns: 'urn:xmpp:hints' }),
        xml('active', { xmlns: CHAT_STATES_NS }),
      ));
      encrypted = true;
      updateOutboundEncryptionStatus(to, id, 'encrypted');
    } else {
      await client.send(xml(
        'message',
        { type: msg.type, to, id },
        xml('body', {}, msg.body),
        xml('active', { xmlns: CHAT_STATES_NS }),
      ));
    }
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

export async function sendMessage(to: string, body: string, type: 'chat' | 'groupchat' = 'chat'): Promise<string> {
  const client = usableClient();
  if (!client) {
    throw new Error('XMPP not connected');
  }
  const id = `nc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const timestamp = new Date().toISOString();

  if (!body.trim()) throw new Error('No se puede enviar un mensaje vacío');

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
  });

  try {
    if (session.account?.omemoEnabled && Omemo.isEnabled()) {
      const isGroup = type === 'groupchat';
      const { encryptedXml, wasEncrypted } = await Omemo.encryptMessage(to, body, isGroup);
      if (wasEncrypted && encryptedXml) {
        await client.send(xml(
          'message',
          { type, to, id },
          encryptedXml,
          xml('encryption', {
            xmlns: 'urn:xmpp:eme:0',
            namespace: 'eu.siacs.conversations.axolotl',
            name: 'OMEMO',
          }),
          xml('store', { xmlns: 'urn:xmpp:hints' }),
          // XEP-0085: un mensaje con cuerpo implica estado active.
          xml('active', { xmlns: CHAT_STATES_NS }),
        ));
        updateOutboundEncryptionStatus(to, id, 'encrypted');
        updateOutboundSendState(to, id, 'sent');
        XmppHistory.recordMessage(
          to, body, 'out', timestamp, null,
          null, null, null, null, null, null, null, null, true,
        ).catch(() => {});
        return id;
      }
      throw new Error(`No hay dispositivos OMEMO compatibles para ${to}`);
    }

    await client.send(xml(
      'message',
      { type, to, id },
      xml('body', {}, body),
      // XEP-0085: un mensaje con cuerpo implica estado active.
      xml('active', { xmlns: CHAT_STATES_NS }),
    ));
    updateOutboundSendState(to, id, 'sent');
  } catch (error) {
    updateOutboundSendState(to, id, 'failed');
    throw error;
  }
  // Cached with no mam_id; the archive copy will be matched onto this row.
  XmppHistory.recordMessage(to, body, 'out', timestamp, null).catch(() => {});
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
