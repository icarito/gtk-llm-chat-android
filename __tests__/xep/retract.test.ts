import { xml } from '@xmpp/client';
import {
  NS_HINTS,
  NS_RETRACT,
  RETRACT_FALLBACK_BODY,
  buildRetract,
  parseRetract,
} from '@/xmpp/xep/retract';
import { NS_FALLBACK } from '@/xmpp/xep/reply';

describe('retract (XEP-0424)', () => {
  it('construye una retractación con fallback y store hint', () => {
    const msg = buildRetract('ana@example.org', 'chat', 'msg-1');

    expect(msg.attrs.type).toBe('chat');
    expect(msg.getChild('retract', NS_RETRACT)?.attrs.id).toBe('msg-1');
    expect(msg.getChildText('body')).toBe(RETRACT_FALLBACK_BODY);
    expect(msg.getChild('fallback', NS_FALLBACK)?.attrs.for).toBe(NS_RETRACT);
    expect(msg.getChild('store', NS_HINTS)).toBeDefined();
    expect(parseRetract(msg)).toBe('msg-1');
  });

  it('parsea el target de groupchat', () => {
    const msg = buildRetract('sala@conference.example.org', 'groupchat', 'stanza-7');
    expect(parseRetract(msg)).toBe('stanza-7');
  });

  it('devuelve null si no hay retract', () => {
    expect(parseRetract(xml('message', { type: 'chat' }))).toBeNull();
  });
});
