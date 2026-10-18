import type { XmppMessage } from '@/types/xmpp';
import { mergeMessages } from '@/chat/mergeMessages';

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
});
