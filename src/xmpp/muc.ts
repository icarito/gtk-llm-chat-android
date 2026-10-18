/** MUC (XEP-0045): manejo mínimo de groupchat. */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import { Omemo } from '@/xmpp/xep-0384';
import { getOmemo2 } from '@/xmpp/omemo2';
import { DISCO_INFO_NS } from '@/xmpp/ns';
import { bareJid } from '@/xmpp/parse';
import { usableClient } from '@/xmpp/session';
import { messages, rooms } from '@/xmpp/store';
import { NS_MUC_ADMIN, NS_MUC_USER } from '@/xmpp/xep/muc';

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

// ── OMEMO 2 en salas (XEP-0384 §7) ──

const AFFILIATION_TTL_MS = 5 * 60 * 1000;
/** disco#info por sala, una vez por join (joinRoom lo reinicia). */
const roomInfo = new Map<string, Promise<boolean>>();
const affiliated = new Map<string, { at: number; jids: string[] }>();

export function resetRoomOmemo(room?: string) {
  if (room) { roomInfo.delete(room); affiliated.delete(room); } else { roomInfo.clear(); affiliated.clear(); }
}

/** ¿La sala admite OMEMO 2? (no anónima). Cachea el disco#info y lo refleja en el estado de la sala. */
export function ensureRoomInfo(room: string): Promise<boolean> {
  let pending = roomInfo.get(room);
  if (!pending) {
    const client = usableClient();
    if (!client) return Promise.resolve(false);
    pending = Promise.resolve().then(() => client.iqCaller.request(
      xml('iq', { type: 'get', to: room }, xml('query', { xmlns: DISCO_INFO_NS })), 10000,
    )).then((res) => {
      const features = (res.getChild('query', DISCO_INFO_NS)?.getChildren('feature') ?? []).map((f) => f.attrs.var);
      const nonAnonymous = features.includes('muc_nonanonymous');
      rooms.patch(room, {
        nonAnonymous,
        membersOnly: features.includes('muc_membersonly'),
        omemoUnavailableReason: nonAnonymous ? undefined : 'sala anónima',
      });
      return nonAnonymous;
    }).catch(() => {
      roomInfo.delete(room); // transitorio: el próximo envío reintenta (mientras tanto, texto plano)
      return false;
    });
    roomInfo.set(room, pending);
  }
  return pending;
}

/** JIDs reales con afiliación member/admin/owner. Errores (forbidden…) se ignoran: puede que no tengamos permiso. */
async function affiliatedJids(room: string): Promise<string[]> {
  const hit = affiliated.get(room);
  if (hit && Date.now() - hit.at < AFFILIATION_TTL_MS) return hit.jids;
  const client = usableClient();
  if (!client) return hit?.jids ?? [];
  const lists = await Promise.all(['member', 'admin', 'owner'].map((affiliation) =>
    client.iqCaller.request(
      xml('iq', { type: 'get', to: room }, xml('query', { xmlns: NS_MUC_ADMIN }, xml('item', { affiliation }))), 10000,
    ).then((res) => (res.getChild('query', NS_MUC_ADMIN)?.getChildren('item') ?? [])
      .map((i) => i.attrs.jid as string | undefined).filter((j): j is string => Boolean(j)))
      .catch(() => [] as string[])));
  const jids = [...new Set(lists.flat().map(bareJid))];
  affiliated.set(room, { at: Date.now(), jids });
  return jids;
}

/**
 * Destinatarios OMEMO 2 de la sala (bare JIDs reales: ocupantes actuales + afiliados,
 * sin nosotros), o null si OMEMO 2 no aplica: sin motor, desactivado para la sala,
 * sala anónima o nadie con dispositivos. Nunca lanza.
 */
export async function omemoRoomRecipients(room: string): Promise<string[] | null> {
  const engine = getOmemo2();
  if (!engine || !engine.isEnabledFor(room)) return null;
  try {
    if (!(await ensureRoomInfo(room))) return null;
    const peers = new Set<string>();
    for (const o of Object.values(rooms.get(room)?.occupants ?? {})) if (o.realJid) peers.add(bareJid(o.realJid));
    for (const j of await affiliatedJids(room)) peers.add(j);
    peers.delete(engine.ownBare);
    const list = [...peers];
    return (await engine.canEncryptGroup(room, list)) ? list : null;
  } catch {
    return null;
  }
}

/**
 * JID real (bare) del remitente de un groupchat, o null. En vivo manda el mapa de
 * ocupantes (un tercero no puede inyectar el JID); en MAM el <item jid> de
 * muc#user (el nick pudo cambiar desde entonces), con el mapa de respaldo.
 */
export function resolveMucSender(stanza: Element, ownBare: string, live: boolean): string | null {
  const [room, nick] = bareJidAndNick((stanza.attrs.from as string) ?? '');
  const item = stanza.getChild('x', NS_MUC_USER)?.getChild('item')?.attrs.jid as string | undefined;
  const r = rooms.get(room);
  const mapped = !r || !nick ? undefined : nick === r.nick ? ownBare : r.occupants[nick]?.realJid;
  const jid = live ? mapped ?? item : item ?? mapped;
  return jid ? bareJid(jid) : null;
}

function bareJidAndNick(from: string): [string, string | undefined] {
  return [bareJid(from), from.split('/')[1]];
}
