import { parse } from 'ltx';
import { parseActionMetadata, parseInlineCommands, parseQuickResponses } from '@/xmpp/XmppService';

describe('NanoClaw XMPP action metadata', () => {
  it('parses standard and legacy quick responses', () => {
    const stanza = parse(
      `<message xmlns="jabber:client" type="chat">
         <body>¿Apruebas?</body>
         <response xmlns="urn:xmpp:quick-response:0" label="Sí" value="yes"/>
         <reference xmlns="urn:xmpp:quick-response:0" type="action">
           <body>no</body>
         </reference>
         <response xmlns="urn:xmpp:tmp:quick-response" label="Abortar" value="abort"/>
       </message>`,
    );

    expect(parseQuickResponses(stanza)).toEqual([
      { label: 'Sí', value: 'yes' },
      { label: 'no', value: 'no' },
      { label: 'Abortar', value: 'abort' },
    ]);
  });

  it('parses inline ad-hoc command items', () => {
    const stanza = parse(
      `<message xmlns="jabber:client" type="chat">
         <body>Selecciona una acción</body>
         <query xmlns="http://jabber.org/protocol/disco#items" node="http://jabber.org/protocol/commands">
           <item jid="clawdio@hablar.fuentelibre.org/mobile" node="q:abc:approve" name="Aprobar" expires-at-ms="1784261952459"/>
           <item jid="clawdio@hablar.fuentelibre.org/mobile" node="q:abc:reject" name="Rechazar"/>
         </query>
       </message>`,
    );

    expect(parseInlineCommands(stanza)).toEqual([
      {
        jid: 'clawdio@hablar.fuentelibre.org/mobile',
        node: 'q:abc:approve',
        name: 'Aprobar',
        expiresAtMs: 1784261952459,
      },
      {
        jid: 'clawdio@hablar.fuentelibre.org/mobile',
        node: 'q:abc:reject',
        name: 'Rechazar',
      },
    ]);
  });

  it('uses command items as the message action surface when both payloads are present', () => {
    const stanza = parse(
      `<message xmlns="jabber:client" type="chat">
         <body>¿Apruebas?</body>
         <response xmlns="urn:xmpp:quick-response:0" label="Sí" value="approve"/>
         <response xmlns="urn:xmpp:quick-response:0" label="No" value="reject"/>
         <query xmlns="http://jabber.org/protocol/disco#items" node="http://jabber.org/protocol/commands">
           <item jid="clawdio@hablar.fuentelibre.org/mobile" node="q:abc:approve" name="Aprobar"/>
           <item jid="clawdio@hablar.fuentelibre.org/mobile" node="q:abc:reject" name="Rechazar"/>
         </query>
       </message>`,
    );

    expect(parseActionMetadata(stanza)).toEqual({
      quickResponses: [],
      commands: [
        {
          jid: 'clawdio@hablar.fuentelibre.org/mobile',
          node: 'q:abc:approve',
          name: 'Aprobar',
        },
        {
          jid: 'clawdio@hablar.fuentelibre.org/mobile',
          node: 'q:abc:reject',
          name: 'Rechazar',
        },
      ],
    });
  });
});
