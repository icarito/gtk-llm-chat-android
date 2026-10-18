import type { XmppMessage } from '@/types/xmpp';
import { ME, RETRACTED_TEXT, toIMessage } from '@/chat/toIMessage';

const SELF: ReadonlySet<string> = new Set(['room@muc/me']);
const msg = (o: Partial<XmppMessage> = {}): XmppMessage => ({
  id: 'm1',
  from: 'bob@x.org/phone',
  to: 'me@x.org',
  type: 'chat',
  body: 'hola',
  timestamp: '2026-01-01T10:00:00.000Z',
  direction: 'in',
  isGroup: false,
  ...o,
});

describe('toIMessage', () => {
  it('maps an incoming chat message', () => {
    const r = toIMessage(msg(), SELF);
    expect(r._id).toBe('m1');
    expect(r.text).toBe('hola');
    expect(r.createdAt).toBe(Date.parse('2026-01-01T10:00:00.000Z'));
    expect(r.user._id).toBe('bob@x.org');
    expect(r.meta.mine).toBe(false);
  });

  it('marks outgoing messages as ME with send state and encryption', () => {
    const pending = toIMessage(msg({ direction: 'out', sendState: 'pending', encryptionStatus: 'omemo2' }), SELF);
    expect(pending.user).toBe(ME);
    expect(pending.pending).toBe(true);
    expect(pending.meta).toMatchObject({ mine: true, sendState: 'pending', encryption: 'omemo2', extras: true });
    expect(toIMessage(msg({ id: 'm2', direction: 'out', sendState: 'sent' }), SELF).sent).toBe(true);
  });

  it('uses the occupant nick in groupchat', () => {
    const r = toIMessage(msg({ type: 'groupchat', isGroup: true, from: 'room@muc', senderNick: 'Ana' }), SELF);
    expect(r.user).toEqual({ _id: 'room@muc/Ana', name: 'Ana' });
  });

  it('falls back to the resource as nick', () => {
    const r = toIMessage(msg({ type: 'groupchat', isGroup: true, from: 'room@muc/Zed' }), SELF);
    expect(r.user.name).toBe('Zed');
  });

  it('maps audio and image attachments', () => {
    const audio = toIMessage(
      msg({ oobUrl: 'https://f.org/a.ogg', body: 'https://f.org/a.ogg', attachmentDuration: 7 }),
      SELF,
    );
    expect(audio.audio).toBe('https://f.org/a.ogg');
    expect(audio.duration).toBe(7);
    const img = toIMessage(msg({ id: 'm3', body: 'mira https://f.org/p.png' }), SELF);
    expect(img.image).toBe('https://f.org/p.png');
    expect(img.text).toBe('mira');
  });

  it('shows a tombstone for retracted messages', () => {
    const r = toIMessage(msg({ retracted: true, body: 'secreto' }), SELF);
    expect(r.text).toBe(RETRACTED_TEXT);
    expect(r.meta.retracted).toBe(true);
  });

  it('maps own reactions to ME', () => {
    const r = toIMessage(msg({ reactions: { '👍': ['room@muc/me', 'x'], '🔥': [] } }), SELF);
    expect(r.reactions).toEqual([{ emoji: '👍', userIds: [ME._id, 'x'] }]);
  });

  it('returns the same object while unchanged and a new one after a change', () => {
    const m = msg();
    const a = toIMessage(m, SELF);
    expect(toIMessage(m, SELF)).toBe(a);
    const changed = { ...m, body: 'editado' };
    const b = toIMessage(changed, SELF);
    expect(b).not.toBe(a);
    expect(b.text).toBe('editado');
    expect(toIMessage(m, new Set(['otro']))).not.toBe(a);
  });
});
