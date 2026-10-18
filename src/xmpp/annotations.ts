/**
 * Reacciones (XEP-0444) y retractaciones (XEP-0424): agregación sobre el store
 * y persistencia, tanto de lo entrante (chat, groupchat, carbon, MAM) como de
 * lo que enviamos.
 *
 * Identidad del objetivo: en chat es el id del mensaje; en groupchat, el
 * stanza-id que asigna la sala (XEP-0359). `matchesTarget` acepta cualquiera de
 * los ids que conocemos del mensaje. Remitente de una reacción: bare JID en
 * chat, `sala/nick` en groupchat.
 */
import type { Element } from '@xmpp/xml';
import type { XmppMessage } from '@/types/xmpp';
import { XmppHistory } from '@/xmpp/XmppHistory';
import { bareJid } from '@/xmpp/parse';
import { session, usableClient } from '@/xmpp/session';
import { messages, rooms } from '@/xmpp/store';
import { buildReactions, foldReactions, parseReactions } from '@/xmpp/xep/reactions';
import { buildRetract, parseRetract } from '@/xmpp/xep/retract';

export type Author = { direction?: 'in' | 'out'; nick?: string };

export function matchesTarget(m: XmppMessage, id: string): boolean {
  return m.id === id || m.stanzaId === id || m.mamId === id;
}

function isGroup(convJid: string): boolean {
  return rooms.get(convJid) !== undefined
    || messages.getConversation(convJid).some((m) => m.type === 'groupchat' || m.isGroup);
}

/** Id con el que los demás conocen el mensaje: stanza-id de la sala en groupchat. */
export function resolveTargetId(convJid: string, id: string): string {
  if (!isGroup(convJid)) return id;
  const m = messages.getConversation(convJid).find((c) => matchesTarget(c, id));
  return m?.stanzaId ?? m?.mamId ?? id;
}

function authorOk(m: XmppMessage, author: Author): boolean {
  return author.nick ? m.senderNick === author.nick : m.direction === author.direction;
}

/** Reemplaza (inmutable) el mensaje `targetId` de la conversación; true si existía en memoria. */
function patchStored(convJid: string, targetId: string, fn: (m: XmppMessage) => XmppMessage | null): boolean {
  const list = messages.getConversation(convJid);
  const idx = list.findIndex((m) => matchesTarget(m, targetId));
  if (idx < 0) return false;
  const next = fn(list[idx]!);
  if (!next) return false;
  const updated = [...list];
  updated[idx] = next;
  messages.setConversation(convJid, updated);
  return true;
}

export function applyReactions(convJid: string, targetId: string, sender: string, emojis: string[]) {
  patchStored(convJid, targetId, (m) => ({ ...m, reactions: foldReactions(m.reactions, sender, emojis) }));
  XmppHistory.updateReactions(convJid, targetId, sender, emojis).catch(() => {});
}

/** Marca la lápida si `author` es quien envió el mensaje (nadie retracta lo ajeno). */
export function applyRetraction(convJid: string, targetId: string, author: Author) {
  patchStored(convJid, targetId, (m) => (authorOk(m, author) ? { ...m, retracted: true } : null));
  XmppHistory.markRetracted(convJid, targetId, author).catch(() => {});
}

/** Aplica sobre una lista aún no publicada (resultado de MAM) lo mismo que sobre el store. */
export function patchList(list: XmppMessage[], targetId: string, fn: (m: XmppMessage) => XmppMessage | null) {
  const idx = list.findIndex((m) => matchesTarget(m, targetId));
  if (idx < 0) return;
  const next = fn(list[idx]!);
  if (next) list[idx] = next;
}

/**
 * Stanza entrante (o reenviada por carbon) con reacciones/retractación para
 * `convJid`. `from` es el JID de quien la envió; `own` = la enviamos nosotros
 * (carbon sent). Devuelve true si era una anotación (ya consumida).
 */
export function handleAnnotation(message: Element, convJid: string, from: string, own: boolean): boolean {
  const group = message.attrs.type === 'groupchat';
  const nick = group ? from.split('/')[1] ?? '' : '';
  const reactions = parseReactions(message);
  if (reactions) {
    const sender = group ? from : own ? bareJid(session.account?.jid ?? from) : bareJid(from);
    applyReactions(convJid, reactions.targetId, sender, reactions.emojis);
    return true;
  }
  const retractId = parseRetract(message);
  if (retractId) {
    applyRetraction(convJid, retractId, group ? { nick } : { direction: own ? 'out' : 'in' });
    return true;
  }
  return false;
}

/** XEP-0444: fija el conjunto COMPLETO de nuestras reacciones al mensaje (vacío = retirarlas). */
export async function react(convJid: string, targetId: string, emojis: string[]): Promise<void> {
  const client = usableClient();
  if (!client) throw new Error('XMPP not connected');
  const group = isGroup(convJid);
  const target = resolveTargetId(convJid, targetId);
  await client.send(buildReactions(convJid, group ? 'groupchat' : 'chat', target, emojis));
  const room = rooms.get(convJid);
  const sender = group ? `${convJid}/${room?.nick ?? ''}` : bareJid(session.account?.jid ?? '');
  applyReactions(convJid, target, sender, emojis);
}

/** XEP-0424: retracta un mensaje propio; deja lápida local. */
export async function retractMessage(convJid: string, id: string): Promise<void> {
  const client = usableClient();
  if (!client) throw new Error('XMPP not connected');
  const msg = messages.getConversation(convJid).find((m) => matchesTarget(m, id));
  if (!msg || msg.direction !== 'out') throw new Error('Sólo se pueden retractar mensajes propios');
  const group = isGroup(convJid);
  const target = group ? msg.stanzaId ?? msg.mamId ?? id : id;
  await client.send(buildRetract(convJid, group ? 'groupchat' : 'chat', target));
  applyRetraction(convJid, target, group ? { nick: msg.senderNick ?? rooms.get(convJid)?.nick } : { direction: 'out' });
}
