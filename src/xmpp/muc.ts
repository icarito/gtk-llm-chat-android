/** MUC (XEP-0045): manejo mínimo de groupchat. */
import type { Element } from '@xmpp/xml';
import { Omemo } from '@/xmpp/xep-0384';
import { messages, rooms } from '@/xmpp/store';

export function isGroupJidEx(barejid: string, mucDomain?: string): boolean {
  if (!mucDomain) return false;
  return barejid.endsWith(`@${mucDomain}`);
}

/**
 * Whether a conversation is a MUC. We have no configured MUC domain and rooms
 * never appear in the RFC 6121 roster, so the signal is a message we already
 * saw arrive (or were sent) as groupchat. Matters for MAM: a room's archive
 * lives on the room JID, not in the account's own archive.
 */
export function isGroupConversation(bareJid: string): boolean {
  return rooms.get(bareJid) !== undefined || messages.getConversation(bareJid).some((m) => m.type === 'groupchat' || m.isGroup);
}

export function messageMentionsBot(stanza: Element, body: string, nick: string, jid: string): boolean {
  const refs = stanza.getChildren('reference');
  for (const ref of refs) {
    if (ref.attrs.type === 'mention') {
      const uri = (ref.attrs.uri as string) || '';
      if (uri.includes(jid) || uri.toLowerCase().includes(nick.toLowerCase())) return true;
    }
  }
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w@])@?${escaped}\\b`, 'i').test(body);
}

/** Occupant real JID de una presencia MUC, para OMEMO en grupos. */
export function trackMucOccupant(stanza: Element, bare: string, ptype: unknown) {
  const mucUser = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
  const mucItem = mucUser?.getChild('item');
  const realJid = mucItem?.attrs.jid as string | undefined;
  if (realJid) {
    if (ptype === 'unavailable') {
      Omemo.removeMucOccupant(bare, realJid);
    } else {
      Omemo.registerMucOccupant(bare, realJid);
    }
  }
}

/** Un groupchat con nuestro propio nick es el eco de lo que enviamos: se ignora. */
export function isOwnGroupchatEcho(from: string, botNick: string): boolean {
  return from.split('/')[1] === botNick;
}
