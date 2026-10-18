import { xml } from '@xmpp/client';
import {
  NS_HINTS,
  NS_REACTIONS,
  buildReactions,
  parseReactions,
} from '@/xmpp/xep/reactions';

describe('reactions (XEP-0444)', () => {
  it('construye y parsea reacciones en un chat', () => {
    const msg = buildReactions('ana@example.org', 'chat', 'msg-1', ['👍', '❤️']);

    expect(msg.name).toBe('message');
    expect(msg.attrs.to).toBe('ana@example.org');
    expect(msg.attrs.type).toBe('chat');
    expect(msg.getChild('store', NS_HINTS)).toBeDefined();

    expect(parseReactions(msg)).toEqual({
      targetId: 'msg-1',
      emojis: ['👍', '❤️'],
    });
  });

  it('en groupchat conserva el tipo y el stanza-id del MUC como target', () => {
    const msg = buildReactions('sala@conference.example.org', 'groupchat', 'stanza-42', ['🎉']);

    expect(msg.attrs.type).toBe('groupchat');
    const reactions = msg.getChild('reactions', NS_REACTIONS);
    expect(reactions?.attrs.id).toBe('stanza-42');
    expect(parseReactions(msg)?.targetId).toBe('stanza-42');
  });

  it('devuelve null si el mensaje no trae reacciones', () => {
    expect(parseReactions(xml('message', { type: 'chat' }, xml('body', {}, 'hola')))).toBeNull();
  });
});
