import { parse } from 'ltx';
import { agents, approvalForStanza, getAgentSnapshot } from '@/xmpp/agents';
import { getActiveCapsFeatures } from '@/xmpp/disco';
import { getAgentTelemetry, handlePubsubEvent } from '@/xmpp/pep';
import { NS_HOOKS_APPROVAL, NS_TELEMETRY } from '@/xmpp/pep/namespaces';

const EV = 'http://jabber.org/protocol/pubsub#event';
const event = (node: string, item: string) =>
  parse(`<message from="bot@x.org/res"><event xmlns="${EV}"><items node="${node}"><item id="current">${item}</item></items></event></message>`);

describe('PEP -> agentState', () => {
  it('telemetría actualiza el store y la fachada plana', () => {
    const stanza = event(NS_TELEMETRY, `<telemetry xmlns="${NS_TELEMETRY}" activity="working"><context used="10" max="100"/><model>m</model></telemetry>`);
    expect(handlePubsubEvent(stanza)).toBe(true);
    expect(agents.get('bot@x.org')?.activity).toBe('working');
    expect(getAgentTelemetry('bot@x.org')).toEqual({ context_used: 10, context_max: 100, model: 'm' });
  });

  it('hook de aprobación se correlaciona por stanzaId', () => {
    const json = JSON.stringify({ approvalId: 'a1', stanzaId: 's1', state: 'pending' });
    handlePubsubEvent(event(NS_HOOKS_APPROVAL, `<hook xmlns="${NS_HOOKS_APPROVAL}">${json}</hook>`));
    expect(agents.pendingApprovals('bot@x.org', Date.now())).toHaveLength(1);
    expect(approvalForStanza('bot@x.org', 's1')?.approvalId).toBe('a1');
    expect(approvalForStanza('bot@x.org', 'nope')).toBeUndefined();
  });

  it('el snapshot es estable entre cambios', () => {
    expect(getAgentSnapshot('bot@x.org')).toBe(getAgentSnapshot('bot@x.org/res'));
  });
});

describe('caps', () => {
  it('anuncia telemetría y hooks con +notify', () => {
    const f = getActiveCapsFeatures();
    for (const n of ['telemetry:0', 'hooks:activity:0', 'hooks:approval:0', 'hooks:progress:0']) {
      expect(f).toContain(`urn:openclaw:${n}+notify`);
    }
    expect(f).toContain('urn:nanoclaw:telemetry:0+notify');
  });
});
