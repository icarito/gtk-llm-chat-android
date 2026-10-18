import { xml } from '@xmpp/client';
import {
  NS_FALLBACK,
  NS_REPLY,
  buildReply,
  parseReply,
} from '@/xmpp/xep/reply';

describe('reply (XEP-0461 + fallback XEP-0428)', () => {
  it('prefija la cita y calcula offsets en codepoints con emoji', () => {
    const quoted = '👍 hola';
    const msg = buildReply('ana@example.org', 'chat', 'mi respuesta', {
      targetId: 'msg-1',
      targetJid: 'ana@example.org',
      quotedText: quoted,
    });

    const body = msg.getChildText('body') ?? '';
    expect(body).toBe(`> ${quoted}\nmi respuesta`);

    const fallback = msg.getChild('fallback', NS_FALLBACK);
    expect(fallback?.attrs.for).toBe(NS_REPLY);
    const range = fallback?.getChild('body');
    expect(range?.attrs.start).toBe('0');

    const prefix = `> ${quoted}\n`;
    expect(Number(range?.attrs.end)).toBe(Array.from(prefix).length);
    // El emoji ocupa 2 unidades UTF-16 pero 1 codepoint: el offset no debe
    // calcularse con `string.length`.
    expect(Number(range?.attrs.end)).toBe(prefix.length - 1);
  });

  it('hace round-trip build -> parse quitando la cita del body', () => {
    const msg = buildReply('ana@example.org', 'chat', 'respuesta final', {
      targetId: 'target-9',
      targetJid: 'ana@example.org',
      quotedText: 'línea uno\nlínea dos',
    });

    expect(parseReply(msg)).toEqual({
      targetId: 'target-9',
      targetJid: 'ana@example.org',
      bodyWithoutFallback: 'respuesta final',
    });
  });

  it('parsea una respuesta sin fallback dejando el body tal cual', () => {
    const msg = xml(
      'message',
      { type: 'chat', from: 'ana@example.org' },
      xml('body', {}, 'texto'),
      xml('reply', { xmlns: NS_REPLY, id: 'm-1' }),
    );

    expect(parseReply(msg)).toEqual({
      targetId: 'm-1',
      bodyWithoutFallback: 'texto',
    });
  });

  it('devuelve null si no es una respuesta', () => {
    expect(parseReply(xml('message', { type: 'chat' }, xml('body', {}, 'hola')))).toBeNull();
  });
});
