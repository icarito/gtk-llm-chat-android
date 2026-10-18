/**
 * Salas MUC (XEP-0045) y marcadores (XEP-0402): modelo observable en el store,
 * presencia de sala, invitaciones y autojoin.
 *
 * Contrato: la presencia de sala (`<x muc#user>`) se enruta ANTES que la de
 * contactos (router.ts) y nunca llega a roster.ts, o un ocupante pondría en
 * verde a un contacto con el mismo bare JID. El historial no se pide al entrar
 * (history maxstanzas=0): lo rellena MAM consultando el JID de la sala.
 */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import type { RoomOccupant, XmppRoomInvite } from '@/types/xmpp';
import { CAPS_NS, DISCO_INFO_NS, PUBSUB_EVENT_NS } from '@/xmpp/ns';
import { bareJid } from '@/xmpp/parse';
import { displayName } from '@/xmpp/presence';
import { session, usableClient } from '@/xmpp/session';
import type { StanzaCtx } from '@/xmpp/session';
import { contacts, invites, rooms } from '@/xmpp/store';
import { trackMucOccupant } from '@/xmpp/muc';
import { getAgentTelemetry } from '@/xmpp/pep';
import {
  NS_BOOKMARKS,
  NS_PUBSUB,
  buildPublishBookmark,
  buildRetractBookmark,
  parseBookmarksItems,
  type Bookmark,
  type BookmarkOptions,
} from '@/xmpp/xep/bookmarks';
import { NS_MUC_USER, buildJoinPresence, parseInvite, parseMucPresence } from '@/xmpp/xep/muc';

function defaultNick(): string {
  return (session.account?.jid ?? '').split('@')[0] || 'yo';
}

// ── Entrar / salir ──

export interface JoinOptions {
  password?: string;
  /** Guarda (o actualiza) el marcador con autojoin; sin esto la sala no sobrevive a la sesión. */
  bookmark?: boolean;
}

export async function joinRoom(jid: string, nick?: string, opts: JoinOptions = {}): Promise<void> {
  const client = usableClient();
  if (!client) throw new Error('XMPP not connected');
  const room = bareJid(jid);
  const chosen = nick || rooms.get(room)?.nick || defaultNick();
  rooms.patch(
    room,
    { nick: chosen, state: 'joining', error: undefined, occupants: {} },
    { name: displayName(room) },
  );
  await client.send(buildJoinPresence(room, chosen, { password: opts.password }));
  if (opts.bookmark) await setBookmark(room, { nick: chosen, name: rooms.get(room)?.name, autojoin: true });
}

/** Sale de la sala; el marcador (si lo hay) se conserva con autojoin=false para no volver a entrar solo. */
export async function leaveRoom(jid: string): Promise<void> {
  const room = bareJid(jid);
  const current = rooms.get(room);
  if (!current) return;
  const client = usableClient();
  if (client && (current.state === 'joined' || current.state === 'joining')) {
    await client.send(xml('presence', { to: `${room}/${current.nick}`, type: 'unavailable' }));
  }
  if (current.bookmarked) {
    await setBookmark(room, { nick: current.nick, name: current.name, autojoin: false });
  }
  rooms.patch(room, { state: 'left', occupants: {} });
}

// ── Presencia de sala ──

/** Resultado de disco#info por `node#ver` de caps: ¿el cliente se anuncia como agente? */
const agentByCaps = new Map<string, Promise<boolean>>();

/** Reinicia la caché (tests / cambio de cuenta). */
export function resetRoomCaches() {
  agentByCaps.clear();
}

function queryIsAgent(ctx: StanzaCtx, room: string, nick: string, key: string): Promise<boolean> {
  let pending = agentByCaps.get(key);
  if (!pending) {
    pending = ctx.client.iqCaller.request(
      xml('iq', { type: 'get', to: `${room}/${nick}` }, xml('query', { xmlns: DISCO_INFO_NS })),
      10000,
    ).then((result) => {
      const query = result.getChild('query', DISCO_INFO_NS);
      const identities = query?.getChildren('identity') ?? [];
      return identities.some((i) => i.attrs.category === 'automation' || i.attrs.type === 'command-list');
    }).catch(() => {
      agentByCaps.delete(key); // fallo transitorio: reintentable con la próxima presencia
      return false;
    });
    agentByCaps.set(key, pending);
  }
  return pending;
}

function setOccupantAgent(room: string, nick: string) {
  const current = rooms.get(room);
  const occ = current?.occupants[nick];
  if (!current || !occ || occ.isAgent) return;
  rooms.patch(room, { occupants: { ...current.occupants, [nick]: { ...occ, isAgent: true } } });
}

/** Agente = telemetría PEP del JID real, o caps cuya identidad es automation/command-list. */
function detectAgent(stanza: Element, ctx: StanzaCtx, room: string, nick: string, realJid?: string) {
  if (realJid && getAgentTelemetry(bareJid(realJid))) {
    setOccupantAgent(room, nick);
    return;
  }
  const c = stanza.getChild('c', CAPS_NS);
  if (!c?.attrs.node || !c.attrs.ver) return;
  void queryIsAgent(ctx, room, nick, `${c.attrs.node}#${c.attrs.ver}`).then((isAgent) => {
    if (isAgent) setOccupantAgent(room, nick);
  });
}

/** Devuelve true si la presencia pertenece a una sala (ya consumida: no llega a los contactos). */
export function handleMucPresence(stanza: Element, ctx: StanzaCtx): boolean {
  const from = stanza.attrs.from as string | undefined;
  if (!from) return false;
  const bare = bareJid(from);
  const muc = parseMucPresence(stanza);

  if (!muc) {
    // Fallo al entrar (nick en uso, contraseña, veto…): presencia de error de una sala que conocemos.
    if (stanza.attrs.type === 'error' && rooms.get(bare)) {
      const condition = stanza.getChild('error')?.children
        .find((c): c is Element => typeof c !== 'string' && c.name !== 'text');
      rooms.patch(bare, { state: 'error', error: condition?.name ?? 'error', occupants: {} });
      return true;
    }
    return false;
  }

  trackMucOccupant(stanza, bare, stanza.attrs.type);
  const current = rooms.get(bare);
  const base = { name: displayName(bare) };
  const occupants = { ...(current?.occupants ?? {}) };

  if (stanza.attrs.type === 'unavailable') {
    if (muc.nickChanged && muc.newNick) {
      // El nick viejo desaparece; la presencia available del nuevo llega a continuación.
      const old = occupants[muc.nick];
      delete occupants[muc.nick];
      if (old) occupants[muc.newNick] = { ...old, nick: muc.newNick };
      rooms.patch(bare, { occupants, ...(muc.self ? { nick: muc.newNick } : {}) }, base);
    } else if (muc.self) {
      const state = muc.banned ? 'banned' : muc.kicked ? 'kicked' : 'left';
      rooms.patch(bare, { state, occupants: {} }, base);
    } else {
      delete occupants[muc.nick];
      rooms.patch(bare, { occupants }, base);
    }
    return true;
  }

  const prev = occupants[muc.nick];
  const occupant: RoomOccupant = {
    nick: muc.nick,
    realJid: muc.realJid ?? prev?.realJid,
    role: muc.role,
    affiliation: muc.affiliation,
    isAgent: prev?.isAgent ?? false,
  };
  occupants[muc.nick] = occupant;
  rooms.patch(
    bare,
    muc.self
      ? { occupants, state: 'joined', error: undefined, nick: muc.nick, role: muc.role, affiliation: muc.affiliation }
      : { occupants },
    base,
  );
  if (!muc.self && !occupant.isAgent) detectAgent(stanza, ctx, bare, muc.nick, muc.realJid);
  return true;
}

// ── Mensajes de sala: asunto e invitaciones ──

/** Asunto e invitaciones (mediadas XEP-0045 y directas XEP-0249). true = consumida. */
export function handleMucMessage(stanza: Element): boolean {
  const from = stanza.attrs.from as string | undefined;
  if (!from || stanza.attrs.type === 'error') return false;

  const invite = parseInvite(stanza);
  if (invite) {
    const room = bareJid(invite.room);
    if (rooms.get(room)?.state === 'joined') return true;
    const inviterBare = bareJid(invite.from);
    // Mediada sin `from` en <invite>: el remitente es la sala; entonces el nick es lo más legible.
    const inviterName = inviterBare === room
      ? invite.from.split('/')[1] ?? ''
      : displayName(inviterBare, contacts.get(inviterBare)?.name);
    const entry: XmppRoomInvite = {
      id: room,
      room,
      roomName: rooms.get(room)?.name ?? displayName(room),
      from: invite.from,
      fromName: inviterName || 'Alguien',
      reason: invite.reason,
      password: invite.password,
      mediated: Boolean(stanza.getChild('x', NS_MUC_USER)?.getChild('invite')),
      timestamp: new Date().toISOString(),
    };
    invites.add(entry);
    return true;
  }

  const subject = stanza.getChild('subject');
  if (stanza.attrs.type === 'groupchat' && subject) {
    const bare = bareJid(from);
    rooms.patch(bare, { subject: subject.text() }, { name: displayName(bare) });
    return !stanza.getChild('body');
  }
  return false;
}

export async function acceptInvite(id: string): Promise<void> {
  const invite = invites.get(id);
  if (!invite) return;
  await joinRoom(invite.room, undefined, { password: invite.password });
  invites.remove(id);
}

export async function declineInvite(id: string): Promise<void> {
  const invite = invites.get(id);
  if (!invite) return;
  invites.remove(id);
  const client = usableClient();
  // Sólo la invitación mediada tiene a quién avisar del rechazo (XEP-0045 §7.8.2).
  if (!client || !invite.mediated) return;
  await client.send(xml(
    'message',
    { to: invite.room },
    xml('x', { xmlns: NS_MUC_USER }, xml('decline', { to: bareJid(invite.from) })),
  ));
}

// ── Marcadores XEP-0402 ──

export async function setBookmark(jid: string, options: BookmarkOptions): Promise<void> {
  const client = usableClient();
  if (!client) throw new Error('XMPP not connected');
  const room = bareJid(jid);
  await client.iqCaller.request(buildPublishBookmark(room, options), 15000);
  rooms.patch(room, { bookmarked: true, ...(options.name ? { name: options.name } : {}) }, { name: displayName(room) });
}

export async function removeBookmark(jid: string): Promise<void> {
  const client = usableClient();
  if (!client) throw new Error('XMPP not connected');
  const room = bareJid(jid);
  await client.iqCaller.request(buildRetractBookmark(room), 15000);
  rooms.patch(room, { bookmarked: false });
}

/** Refleja marcadores en el modelo y entra a los de autojoin que aún no estén dentro. */
function applyBookmarks(list: Bookmark[]) {
  for (const b of list) {
    const current = rooms.get(b.jid);
    rooms.patch(
      b.jid,
      {
        bookmarked: true,
        ...(b.name ? { name: b.name } : {}),
        ...(b.nick && !current?.nick ? { nick: b.nick } : {}),
      },
      { name: displayName(b.jid) },
    );
    const active = current?.state === 'joined' || current?.state === 'joining';
    if (b.autojoin && !active) joinRoom(b.jid, b.nick).catch(() => {});
  }
}

/**
 * Tras roster + presencia inicial de una sesión NUEVA (no reanudada con SM: el
 * servidor ya no tiene nuestra presencia en ninguna sala): trae los marcadores,
 * entra a los de autojoin y vuelve a las salas en que estábamos.
 */
export async function startRooms(ctx: StanzaCtx): Promise<void> {
  const wanted = rooms.getAll().filter((r) => r.state === 'joined' || r.state === 'joining');
  for (const r of wanted) rooms.patch(r.jid, { state: 'left', occupants: {} });

  try {
    const result = await ctx.client.iqCaller.request(
      xml('iq', { type: 'get' }, xml('pubsub', { xmlns: NS_PUBSUB }, xml('items', { node: NS_BOOKMARKS }))),
      15000,
    );
    const items = result.getChild('pubsub', NS_PUBSUB)?.getChild('items');
    if (items) applyBookmarks(parseBookmarksItems(items));
  } catch {
    // Sin nodo de marcadores (cuenta nueva) o sin soporte: nada que autojoin.
  }

  for (const r of wanted) {
    const now = rooms.get(r.jid);
    if (now?.state === 'left') joinRoom(r.jid, r.nick).catch(() => {});
  }
}

/** Notificación PEP de marcadores (`urn:xmpp:bookmarks:1+notify`). true = consumida. */
export function handleBookmarksEvent(stanza: Element, ctx: StanzaCtx): boolean {
  const items = stanza.getChild('event', PUBSUB_EVENT_NS)?.getChild('items');
  if (items?.attrs.node !== NS_BOOKMARKS) return false;
  // Sólo vale lo que publica nuestra propia cuenta.
  const from = stanza.attrs.from as string | undefined;
  if (from && bareJid(from) !== bareJid(ctx.config.jid)) return true;
  applyBookmarks(parseBookmarksItems(items));
  for (const retract of items.getChildren('retract')) {
    const id = retract.attrs.id as string | undefined;
    if (id && rooms.get(id)) rooms.patch(id, { bookmarked: false });
  }
  return true;
}
