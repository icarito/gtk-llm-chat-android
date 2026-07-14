import { parse } from 'ltx';
import { parseInlineCommands, parseQuickResponses } from '@/xmpp/XmppService';

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
           <item jid="clawdio@hablar.fuentelibre.org/mobile" node="q:abc:approve" name="Aprobar"/>
           <item jid="clawdio@hablar.fuentelibre.org/mobile" node="q:abc:reject" name="Rechazar"/>
         </query>
       </message>`,
    );

    expect(parseInlineCommands(stanza)).toEqual([
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
    ]);
  });
});
