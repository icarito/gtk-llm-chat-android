import { xml } from '@xmpp/xml';
import {
  parseJingleMessage,
  buildJingleMessage,
  unwrapCarbonJingleMessage,
} from '@/xmpp/jingle/message';
import { MESSAGE_NS, RTP_NS } from '@/xmpp/jingle/types';

/**
 * Wire format REAL de XEP-0353: cada acción es un elemento hijo directo de
 * <message> (`<propose xmlns='urn:xmpp:jingle-message:0' id='...'/>`), tal
 * como lo generan Dino, AnotherIM y Conversations. No existe ningún
 * contenedor `<jingle-message action='...'/>`.
 */
describe('XEP-0353 wire format', () => {
  it('parsea el propose del ejemplo 1 del XEP (wire format de Dino)', () => {
    const msg = xml(
      'message',
      { from: 'juliet@capulet.example/phone', to: 'romeo@x.org/res', type: 'chat' },
      xml('propose', { xmlns: MESSAGE_NS, id: 'xs14j10w' },
        xml('description', { xmlns: RTP_NS, media: 'audio' })),
      xml('store', { xmlns: 'urn:xmpp:hints' }),
    );
    expect(parseJingleMessage(msg)).toEqual({
      action: 'propose',
      id: 'xs14j10w',
      description: { media: 'audio' },
    });
  });

  it('parsea ringing/reject/retract/proceed/accept/finish de Dino', () => {
    for (const action of ['ringing', 'reject', 'retract', 'proceed', 'accept', 'finish'] as const) {
      const msg = xml(
        'message',
        { from: 'juliet@capulet.example/phone', to: 'romeo@x.org/res', type: 'chat' },
        xml(action, { xmlns: MESSAGE_NS, id: 'xs14j10w' }),
      );
      expect(parseJingleMessage(msg)).toEqual({ action, id: 'xs14j10w' });
    }
  });

  it('devuelve null para mensajes que no son del protocolo', () => {
    const body = xml('message', { from: 'x@x.org/r', type: 'chat' }, xml('body', {}, 'hola'));
    expect(parseJingleMessage(body)).toBeNull();

    // El elemento correcto con OTRO namespace (urn:xmpp:jingle-message:1, variantes viejas).
    const wrongNs = xml(
      'message',
      { from: 'x@x.org/r', type: 'chat' },
      xml('propose', { xmlns: 'urn:xmpp:jingle-message:1', id: 'x' }),
    );
    expect(parseJingleMessage(wrongNs)).toBeNull();
  });

  it('propose sin media conocida se descarta', () => {
    const msg = xml(
      'message',
      { from: 'x@x.org/r', type: 'chat' },
      xml('propose', { xmlns: MESSAGE_NS, id: 'x' },
        xml('description', { xmlns: RTP_NS, media: 'telephone-event' })),
    );
    expect(parseJingleMessage(msg)).toBeNull();
  });

  it('genera propose con description y <store/> de XEP-0334', () => {
    const msg = buildJingleMessage('propose', { id: 'call-123', media: 'audio' });
    expect(msg.name).toBe('message');
    expect(msg.attrs.type).toBe('chat');
    const propose = msg.getChild('propose', MESSAGE_NS)!;
    expect(propose).toBeDefined();
    expect(propose.attrs.id).toBe('call-123');
    expect(propose.getChild('description', RTP_NS)!.attrs.media).toBe('audio');
    expect(msg.getChild('store', 'urn:xmpp:hints')).toBeDefined();
  });

  it('proceed no lleva description', () => {
    const msg = buildJingleMessage('proceed', { id: 'call-123', media: 'audio' });
    const proceed = msg.getChild('proceed', MESSAGE_NS)!;
    expect(proceed.attrs.id).toBe('call-123');
    expect(proceed.getChild('description', RTP_NS)).toBeUndefined();
  });

  it('el mensaje generado se re-parsea con la propia gramática (round-trip)', () => {
    const msg = buildJingleMessage('propose', { id: 'call-456', media: 'audio' });
    expect(parseJingleMessage(msg)).toEqual({
      action: 'propose',
      id: 'call-456',
      description: { media: 'audio' },
    });
  });
});

/**
 * Carbons (XEP-0280): mod_message de Prosody entrega el propose sin body
 * sólo al top_resources; al resto llega envuelto en <received><forwarded>.
 */
describe('carbons unwrap (XEP-0280)', () => {
  it('desenvuelve el propuse de un carbon received', () => {
    const inner = xml(
      'message',
      { from: 'juliet@capulet.example/phone', to: 'romeo@x.org', type: 'chat' },
      xml('propose', { xmlns: MESSAGE_NS, id: 'xs14j10w' },
        xml('description', { xmlns: RTP_NS, media: 'audio' })),
    );
    const carbon = xml(
      'message',
      { from: 'romeo@x.org', to: 'romeo@x.org/phone', type: 'chat' },
      xml('received', { xmlns: 'urn:xmpp:carbons:2' },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, inner)),
    );
    const unwrapped = unwrapCarbonJingleMessage(carbon);
    expect(unwrapped?.kind).toBe('received');
    expect(parseJingleMessage(unwrapped!.message)).toEqual({
      action: 'propose',
      id: 'xs14j10w',
      description: { media: 'audio' },
    });
    // El from REAL (el peer) está en el mensaje interior, no en el wrapper.
    expect(unwrapped!.message.attrs.from).toBe('juliet@capulet.example/phone');
  });

  it('reconoce sent (eco de nuestra propia llamada) y devuelve null sin carbon', () => {
    const inner = xml(
      'message',
      { to: 'juliet@capulet.example/phone', type: 'chat' },
      xml('propose', { xmlns: MESSAGE_NS, id: 'call-abc' },
        xml('description', { xmlns: RTP_NS, media: 'audio' })),
    );
    const sent = xml(
      'message',
      { from: 'romeo@x.org', to: 'romeo@x.org/laptop', type: 'chat' },
      xml('sent', { xmlns: 'urn:xmpp:carbons:2' },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, inner)),
    );
    expect(unwrapCarbonJingleMessage(sent)?.kind).toBe('sent');
    expect(unwrapCarbonJingleMessage(inner)).toBeNull();
  });
});
