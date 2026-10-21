import { buildRoster, filterRoster, inviteText, previewText, roleWord } from '@/components/nav/rosterLogic';
import type { XmppContact, XmppMessage, XmppRoom } from '@/types/xmpp';

const c = (jid: string, extra: Partial<XmppContact> = {}): XmppContact =>
  ({ jid, name: '', subscription: 'both', presence: 'online', ...extra });
const room = (jid: string, extra: Partial<XmppRoom> = {}): XmppRoom =>
  ({ jid, nick: 'yo', state: 'left', bookmarked: false, occupants: {}, role: '', affiliation: '', ...extra });
const msg = (extra: Partial<XmppMessage>): XmppMessage =>
  ({ id: '1', from: '', to: '', type: 'chat', body: 'hola', timestamp: '2026-01-01T00:00:00Z', direction: 'in', isGroup: false, ...extra });

describe('roster', () => {
  const last: Record<string, XmppMessage> = { 'b@x': msg({ timestamp: '2026-02-01T00:00:00Z' }) };
  const items = buildRoster(
    [c('a@x'), c('b@x'), c('bot@x', { status: 'nanoclaw:{}' }), c('ag@x')],
    [room('r@m', { bookmarked: true }), room('gone@m')],
    new Set(['ag@x']),
    (jid) => last[jid],
    () => 0,
  );

  it('clasifica, omite salas sin marcador ni sesión y ordena por actividad', () => {
    expect(items.map((i) => i.jid)).toEqual(['b@x', 'a@x', 'ag@x', 'bot@x', 'r@m']);
    expect(items[0]?.jid).toBe('b@x');
    expect(items.find((i) => i.jid === 'gone@m')).toBeUndefined();
  });

  it('filtra por tipo', () => {
    expect(filterRoster(items, 'agents').map((i) => i.jid).sort()).toEqual(['ag@x', 'bot@x']);
    expect(filterRoster(items, 'contacts').map((i) => i.jid).sort()).toEqual(['a@x', 'b@x']);
    expect(filterRoster(items, 'rooms').map((i) => i.jid)).toEqual(['r@m']);
    expect(filterRoster(items, 'all')).toHaveLength(5);
  });

  it('previews cifrados', () => {
    expect(previewText(msg({ encryptionStatus: 'undecryptable', body: '🔒 x' }))).toBe('mensaje cifrado');
    expect(previewText(msg({ direction: 'out', encryptionStatus: 'encrypted' }))).toBe('Tú: mensaje cifrado');
    expect(previewText(msg({ encryptionStatus: 'omemo2' }))).toBe('hola');
  });

  it('humaniza invitaciones', () => {
    expect(inviteText({ fromName: '', from: 'ana@x/res', roomName: '', room: 'dev@conf.x' })).toBe('ana te invita a #dev');
  });

  it('roles en palabras llanas', () => {
    expect(roleWord('moderator', 'owner')).toBe('Propietario');
    expect(roleWord('participant', 'member')).toBe('Participante');
    expect(roleWord('visitor', 'none')).toBe('Visitante');
  });
});
