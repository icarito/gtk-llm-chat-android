import { buildCommandExecuteStanza } from '@/xmpp/outbound-render';

describe('outbound approval command', () => {
  it('emits a XEP-0050 execute IQ to the advertised full JID and node', () => {
    const stanza = buildCommandExecuteStanza(
      'operator@hablar.fuentelibre.org/openclaw-operator',
      'cmd:approval-message:0',
      'cmd-test',
    );

    expect(stanza.name).toBe('iq');
    expect(stanza.attrs).toMatchObject({
      type: 'set',
      to: 'operator@hablar.fuentelibre.org/openclaw-operator',
      id: 'cmd-test',
    });
    const command = stanza.getChild(
      'command',
      'http://jabber.org/protocol/commands',
    );
    expect(command?.attrs).toMatchObject({
      node: 'cmd:approval-message:0',
      action: 'execute',
    });
  });
});
