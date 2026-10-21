import type { XmppMessage } from '@/types/xmpp';
import { isUndecryptableBody, mergeMessages } from '@/chat/mergeMessages';

const msg = (id: string, ts: string, o: Partial<XmppMessage> = {}): XmppMessage => ({
  id,
  from: 'bob@x.org',
  to: 'me@x.org',
  type: 'chat',
  body: `body-${id}`,
  timestamp: ts,
  direction: 'in',
  isGroup: false,
  ...o,
});

describe('mergeMessages', () => {
  it('orders newest first', () => {
    const a = msg('a', '2026-01-01T10:00:00Z');
    const b = msg('b', '2026-01-01T10:05:00Z');
    const c = msg('c', '2026-01-01T10:02:00Z');
    expect(mergeMessages([a, b], [c])).toEqual([b, c, a]);
  });

  it('dedupes by id', () => {
    const a = msg('a', '2026-01-01T10:00:00Z');
    expect(mergeMessages([a], [{ ...a }])).toHaveLength(1);
  });

  it('dedupes same text and direction within the window, live store wins', () => {
    const live = msg('local-1', '2026-01-01T10:00:00Z', { body: 'hi', direction: 'out' });
    const archived = msg('srv-1', '2026-01-01T10:00:10Z', { body: 'hi', direction: 'out' });
    const out = mergeMessages([live], [archived]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(live);
  });

  it('keeps same text outside the window or with another direction', () => {
    const a = msg('a', '2026-01-01T10:00:00Z', { body: 'hi' });
    const later = msg('b', '2026-01-01T10:05:00Z', { body: 'hi' });
    const other = msg('c', '2026-01-01T10:00:05Z', { body: 'hi', direction: 'out' });
    expect(mergeMessages([a], [later, other])).toHaveLength(3);
  });

  it('keeps object identity of the inputs', () => {
    const a = msg('a', '2026-01-01T10:00:00Z');
    const b = msg('b', '2026-01-01T10:01:00Z');
    const out = mergeMessages([a], [b]);
    expect(out[0]).toBe(b);
    expect(out[1]).toBe(a);
  });

  it('isUndecryptableBody detecta el placeholder de decrypt.ts', () => {
    expect(isUndecryptableBody('🔒 [Mensaje OMEMO 2: activa el cifrado para descifrarlo]')).toBe(true);
    expect(isUndecryptableBody('  🔒 [Error al desencriptar mensaje OMEMO]')).toBe(true);
    expect(isUndecryptableBody('hola 🔒 [no]')).toBe(false);
    expect(isUndecryptableBody('')).toBe(false);
  });

  it('prefiere el descifrado sobre el placeholder (placeholder después)', () => {
    const ts = '2026-01-01T10:00:00Z';
    const plain = msg('srv-1', ts, { body: 'mensaje claro' });
    const locked = msg('mam-1', ts, { body: '🔒 [Mensaje OMEMO 2: activa el cifrado para descifrarlo]' });
    const out = mergeMessages([plain], [locked]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(plain);
  });

  it('prefiere el descifrado sobre el placeholder (placeholder antes)', () => {
    const ts = '2026-01-01T10:00:00Z';
    const locked = msg('mam-1', ts, { body: '🔒 [Mensaje OMEMO: no descifrable en este dispositivo]' });
    const plain = msg('srv-1', ts, { body: 'mensaje claro' });
    const out = mergeMessages([locked], [plain]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(plain);
  });

  it('no colapsa mensajes distintos con otro remitente aunque compartan timestamp', () => {
    const ts = '2026-01-01T10:00:00Z';
    const a = msg('a', ts, { from: 'bob@x.org', body: '🔒 [uno]' });
    const b = msg('b', ts, { from: 'ana@x.org', body: '🔒 [dos]' });
    expect(mergeMessages([a], [b])).toHaveLength(2);
  });
});
