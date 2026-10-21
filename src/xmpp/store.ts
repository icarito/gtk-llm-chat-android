/**
 * Estado observable de la app (contactos, mensajes, acciones pendientes).
 *
 * API compatible con useSyncExternalStore: `subscribe*` + `get*` devolviendo
 * snapshots ESTABLES (misma referencia mientras nada cambie). Los mensajes se
 * suscriben por conversación: corregir un mensaje de A sólo avisa a quienes
 * escuchan A. Los arrays de cada conversación son inmutables — quien los
 * modifica los reemplaza (`setConversation`), nunca los muta.
 */
import type { XmppContact, XmppMessage, XmppPendingAction, XmppRoom, XmppRoomInvite } from '@/types/xmpp';

const EMPTY: readonly XmppMessage[] = Object.freeze([]);

class Listeners {
  private set = new Set<() => void>();
  add(fn: () => void): () => void {
    this.set.add(fn);
    return () => { this.set.delete(fn); };
  }
  emit() { [...this.set].forEach((fn) => fn()); }
}

// ── Mensajes ──

const conversations = new Map<string, readonly XmppMessage[]>();
const perConversation = new Map<string, Listeners>();
const allMessages = new Listeners();
let messagesVersion = 0;
let messagesSnapshot: { version: number; map: Map<string, XmppMessage[]> } | null = null;

export const messages = {
  /** Snapshot inmutable de una conversación (`[]` compartido si no existe). */
  getConversation(jid: string): readonly XmppMessage[] {
    return conversations.get(jid) ?? EMPTY;
  },

  hasConversation(jid: string): boolean {
    return conversations.has(jid);
  },

  setConversation(jid: string, next: readonly XmppMessage[]) {
    conversations.set(jid, next);
    messagesVersion++;
    perConversation.get(jid)?.emit();
    allMessages.emit();
  },

  /** Avisa sólo a los suscriptores de `jid` (y a los globales). */
  subscribe(jid: string, cb: () => void): () => void {
    let l = perConversation.get(jid);
    if (!l) { l = new Listeners(); perConversation.set(jid, l); }
    return l.add(cb);
  },

  subscribeAll(cb: () => void): () => void {
    return allMessages.add(cb);
  },

  /**
   * Mapa completo para consumidores globales (lista de chats). Se copia SÓLO
   * si cambió algo desde la última lectura, en vez de en cada notificación.
   */
  getAll(): Map<string, XmppMessage[]> {
    if (!messagesSnapshot || messagesSnapshot.version !== messagesVersion) {
      messagesSnapshot = {
        version: messagesVersion,
        map: new Map(conversations as Map<string, XmppMessage[]>),
      };
    }
    return messagesSnapshot.map;
  },

  /**
   * Nueva sesión: descarta lo acumulado SIN notificar (igual que antes de la
   * refactorización: la UI sigue con lo que tenía hasta el siguiente cambio).
   */
  reset() {
    conversations.clear();
  },
};

// ── Contactos ──

const contactsMap = new Map<string, XmppContact>();
const contactListeners = new Listeners();
let contactsSnapshot: XmppContact[] = [];

export const contacts = {
  get(jid: string): XmppContact | undefined {
    return contactsMap.get(jid);
  },
  set(jid: string, contact: XmppContact) {
    contactsMap.set(jid, contact);
  },
  clear() {
    contactsMap.clear();
  },
  getAll(): XmppContact[] {
    return contactsSnapshot;
  },
  /** Publica los cambios hechos con set/clear: nuevo snapshot + notificación. */
  commit() {
    contactsSnapshot = [...contactsMap.values()];
    contactListeners.emit();
  },
  subscribe(cb: () => void): () => void {
    return contactListeners.add(cb);
  },
  /** Nueva sesión: vacía el mapa de trabajo; el snapshot se renueva en el próximo commit(). */
  reset() {
    contactsMap.clear();
  },
};

// ── Acciones pendientes ──

/** Mapa mutable (la lógica de caducidad/resolución vive en actions.ts); `commit()` publica. */
export const pendingActions = {
  map: new Map<string, XmppPendingAction>(),
  snapshot: [] as XmppPendingAction[],
  listeners: new Listeners(),
  getAll(): XmppPendingAction[] {
    return this.snapshot;
  },
  commit() {
    this.snapshot = [...this.map.values()];
    this.listeners.emit();
  },
  subscribe(cb: () => void): () => void {
    return this.listeners.add(cb);
  },
  /** Refresca el snapshot sin notificar (lecturas síncronas tras una poda). */
  refresh() {
    this.snapshot = [...this.map.values()];
  },
};

// ── No leídos ──

const unreadCounts = new Map<string, number>();
const unreadListeners = new Listeners();
let unreadTotal = 0;

export const unread = {
  get(jid: string): number {
    return unreadCounts.get(jid) ?? 0;
  },
  total(): number {
    return unreadTotal;
  },
  increment(jid: string) {
    unreadCounts.set(jid, (unreadCounts.get(jid) ?? 0) + 1);
    unreadTotal++;
    unreadListeners.emit();
  },
  clear(jid: string) {
    const c = unreadCounts.get(jid);
    if (!c) return;
    unreadCounts.delete(jid);
    unreadTotal = Math.max(0, unreadTotal - c);
    unreadListeners.emit();
  },
  reset() {
    unreadCounts.clear();
    unreadTotal = 0;
    unreadListeners.emit();
  },
  subscribe(cb: () => void): () => void {
    return unreadListeners.add(cb);
  },
};

// ── Salas (MUC) e invitaciones ──

const roomsMap = new Map<string, XmppRoom>();
const roomListeners = new Listeners();
let roomsSnapshot: readonly XmppRoom[] = Object.freeze([]);

/** Cada sala es inmutable: `patch` la reemplaza, así `get(jid)` es un snapshot estable por sala. */
export const rooms = {
  get(jid: string): XmppRoom | undefined {
    return roomsMap.get(jid);
  },
  getAll(): readonly XmppRoom[] {
    return roomsSnapshot;
  },
  /** Crea la sala si no existe (con `base`) y aplica `patch`. */
  patch(jid: string, patch: Partial<XmppRoom>, base?: Partial<XmppRoom>) {
    const prev = roomsMap.get(jid) ?? {
      jid, nick: '', state: 'left', bookmarked: false, occupants: {}, role: '', affiliation: '', ...base,
    } as XmppRoom;
    roomsMap.set(jid, { ...prev, ...patch });
    roomsSnapshot = Object.freeze([...roomsMap.values()]);
    roomListeners.emit();
  },
  remove(jid: string) {
    if (!roomsMap.delete(jid)) return;
    roomsSnapshot = Object.freeze([...roomsMap.values()]);
    roomListeners.emit();
  },
  subscribe(cb: () => void): () => void {
    return roomListeners.add(cb);
  },
  /** Nueva cuenta: vacía sin notificar. */
  reset() {
    roomsMap.clear();
    roomsSnapshot = Object.freeze([]);
  },
};

const invitesMap = new Map<string, XmppRoomInvite>();
const inviteListeners = new Listeners();
let invitesSnapshot: readonly XmppRoomInvite[] = Object.freeze([]);

export const invites = {
  getAll(): readonly XmppRoomInvite[] {
    return invitesSnapshot;
  },
  get(id: string): XmppRoomInvite | undefined {
    return invitesMap.get(id);
  },
  add(invite: XmppRoomInvite) {
    invitesMap.set(invite.id, invite);
    invitesSnapshot = Object.freeze([...invitesMap.values()]);
    inviteListeners.emit();
  },
  remove(id: string) {
    if (!invitesMap.delete(id)) return;
    invitesSnapshot = Object.freeze([...invitesMap.values()]);
    inviteListeners.emit();
  },
  subscribe(cb: () => void): () => void {
    return inviteListeners.add(cb);
  },
  reset() {
    invitesMap.clear();
    invitesSnapshot = Object.freeze([]);
  },
};
