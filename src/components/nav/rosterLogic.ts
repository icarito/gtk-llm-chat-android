/** Lógica pura del roster de Inicio: filtros, orden y vista previa. */
import type { XmppContact, XmppMessage, XmppRoom, XmppRoomInvite } from '@/types/xmpp';
import { displayName } from '@/xmpp/presence';

export type RosterFilter = 'all' | 'agents' | 'contacts' | 'rooms';
export type RosterKind = 'agent' | 'contact' | 'room';

export const ROSTER_FILTERS: { key: RosterFilter; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'agents', label: 'Agentes' },
  { key: 'contacts', label: 'Contactos' },
  { key: 'rooms', label: 'Salas' },
];

export interface RosterItem {
  kind: RosterKind;
  jid: string;
  name: string;
  /** Epoch ms del último mensaje (0 si no hay). */
  activity: number;
  contact?: XmppContact;
  room?: XmppRoom;
}

/** Vista previa; si el cuerpo no es legible (sin descifrar o fila heredada del historial) dice "mensaje cifrado". */
export function previewText(msg: XmppMessage | undefined): string {
  if (!msg) return '';
  const unreadable = msg.encryptionStatus === 'undecryptable' || msg.encryptionStatus === 'encrypted';
  return `${msg.direction === 'out' ? 'Tú: ' : ''}${unreadable ? 'mensaje cifrado' : msg.body}`;
}

function activityOf(msg: XmppMessage | undefined): number {
  if (!msg) return 0;
  const ms = new Date(msg.timestamp).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Une contactos y salas (unidas o marcadas) en filas ordenadas por actividad;
 * sin historial, al final y por nombre.
 */
export function buildRoster(
  contacts: readonly XmppContact[],
  rooms: readonly XmppRoom[],
  agentJids: ReadonlySet<string>,
  lastMessage: (jid: string) => XmppMessage | undefined,
): RosterItem[] {
  const items: RosterItem[] = [];
  for (const contact of contacts) {
    const isAgent = agentJids.has(contact.jid) || !!contact.status?.startsWith('nanoclaw:');
    items.push({
      kind: isAgent ? 'agent' : 'contact',
      jid: contact.jid,
      name: displayName(contact.jid, contact.name),
      activity: activityOf(lastMessage(contact.jid)),
      contact,
    });
  }
  for (const room of rooms) {
    if (!room.bookmarked && room.state !== 'joined' && room.state !== 'joining') continue;
    items.push({
      kind: 'room',
      jid: room.jid,
      name: room.name || displayName(room.jid),
      activity: activityOf(lastMessage(room.jid)),
      room,
    });
  }
  return items.sort((a, b) => b.activity - a.activity || a.name.localeCompare(b.name));
}

export function filterRoster(items: readonly RosterItem[], filter: RosterFilter): RosterItem[] {
  if (filter === 'all') return [...items];
  const kind: RosterKind = filter === 'agents' ? 'agent' : filter === 'rooms' ? 'room' : 'contact';
  return items.filter((i) => i.kind === kind);
}

export function inviteText(invite: Pick<XmppRoomInvite, 'fromName' | 'from' | 'roomName' | 'room'>): string {
  const who = invite.fromName || displayName(invite.from);
  const room = invite.roomName || displayName(invite.room);
  return `${who} te invita a #${room.replace(/^#/, '')}`;
}

const ROLE_WORD: Record<string, string> = { moderator: 'Moderador', participant: 'Participante', visitor: 'Visitante', none: 'Sin rol' };
const AFFILIATION_WORD: Record<string, string> = { owner: 'Propietario', admin: 'Administrador', member: 'Miembro', outcast: 'Vetado' };

/** Rol en palabras llanas: la afiliación alta (dueño/admin) manda sobre el rol de sesión. */
export function roleWord(role: string, affiliation: string): string {
  if (affiliation === 'owner' || affiliation === 'admin') return AFFILIATION_WORD[affiliation] ?? affiliation;
  return ROLE_WORD[role] ?? role;
}
