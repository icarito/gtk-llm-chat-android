import { displayName, presenceColor, presenceLabel } from '@/xmpp/presence';
import { pendingOutboundCount } from '@/xmpp/pendingCount';
import { Colors } from '@/constants/theme';
import type { XmppMessage } from '@/types/xmpp';

function msg(direction: 'in' | 'out', id = Math.random().toString()): XmppMessage {
  return {
    id,
    from: direction === 'in' ? 'rolando@hablar.fuentelibre.org' : 'me@hablar.fuentelibre.org',
    to: direction === 'in' ? 'me@hablar.fuentelibre.org' : 'rolando@hablar.fuentelibre.org',
    type: 'chat',
    body: 'x',
    timestamp: new Date().toISOString(),
    direction,
  } as XmppMessage;
}

describe('displayName', () => {
  it('prefers the roster name', () => {
    expect(displayName('rolando@hablar.fuentelibre.org', 'Rolando')).toBe('Rolando');
  });

  it('falls back to the local part when there is no name', () => {
    expect(displayName('rolando@hablar.fuentelibre.org')).toBe('rolando');
    expect(displayName('rolando@hablar.fuentelibre.org', '')).toBe('rolando');
    expect(displayName('rolando@hablar.fuentelibre.org', '   ')).toBe('rolando');
  });

  it('strips the resource', () => {
    expect(displayName('rolando@hablar.fuentelibre.org/openclaw')).toBe('rolando');
  });
});

describe('presence', () => {
  it('distinguishes dnd and away instead of collapsing to offline', () => {
    expect(presenceColor('online')).toBe(Colors.success);
    expect(presenceColor('dnd')).toBe(Colors.error);
    expect(presenceColor('away')).toBe(Colors.warning);
    expect(presenceColor('xa')).toBe(Colors.warning);
    expect(presenceColor('offline')).toBe(Colors.muted);
  });

  it('labels each state', () => {
    expect(presenceLabel('dnd')).toBe('Ocupado');
    expect(presenceLabel('online')).toBe('En línea');
    expect(presenceLabel('offline')).toBe('Desconectado');
  });
});

describe('pendingOutboundCount', () => {
  it('counts outbound messages since the last reply', () => {
    expect(pendingOutboundCount([msg('in'), msg('out'), msg('out')])).toBe(2);
  });

  it('is zero when the agent had the last word', () => {
    expect(pendingOutboundCount([msg('out'), msg('in')])).toBe(0);
  });

  it('is zero on an empty conversation', () => {
    expect(pendingOutboundCount([])).toBe(0);
  });

  it('counts everything when the agent never replied', () => {
    expect(pendingOutboundCount([msg('out'), msg('out'), msg('out')])).toBe(3);
  });
});
