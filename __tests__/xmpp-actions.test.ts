import { parse } from 'ltx';
import {
  actionsLookLikeApproval,
  approvalFallbackExpiry,
  classifyApprovalCommandResult,
  parseActionMetadata,
  parseInlineCommands,
  parseQuickResponses,
} from '@/xmpp/XmppService';
import { isXmppNotificationNoise } from '@/xmpp/notifications';
import type { XmppMessage } from '@/types/xmpp';

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

  it('accepts the gateway dual approval payload and prefers XEP-0050', () => {
    const stanza = parse(
      `<message xmlns="jabber:client" type="chat">
         <body>OpenClaw Approval required.</body>
         <response xmlns="urn:xmpp:tmp:quick-response" label="Allow Once" value="/approve approval-id allow-once"/>
         <response xmlns="urn:xmpp:tmp:quick-response" label="Deny" value="/approve approval-id deny"/>
         <query xmlns="http://jabber.org/protocol/disco#items" node="http://jabber.org/protocol/commands">
           <item jid="operator@hablar.fuentelibre.org/openclaw-operator" node="cmd:approval-message:0" name="Allow Once"/>
           <item jid="operator@hablar.fuentelibre.org/openclaw-operator" node="cmd:approval-message:2" name="Deny"/>
         </query>
       </message>`,
    );

    expect(parseActionMetadata(stanza)).toEqual({
      quickResponses: [],
      commands: [
        {
          jid: 'operator@hablar.fuentelibre.org/openclaw-operator',
          node: 'cmd:approval-message:0',
          name: 'Allow Once',
        },
        {
          jid: 'operator@hablar.fuentelibre.org/openclaw-operator',
          node: 'cmd:approval-message:2',
          name: 'Deny',
        },
      ],
    });
  });

  it('keeps legacy approvals actionable for the gateway 30-minute TTL', () => {
    const timestamp = '2026-07-18T12:00:00.000Z';
    const quickResponses = [{ label: 'Confirm', value: 'opaque-token' }];
    const message = {
      id: 'approval-1',
      from: 'agent@example.org',
      to: 'me@example.org',
      type: 'chat',
      body: '🔒 Pending command: rm temporary-file',
      timestamp,
      direction: 'in',
      isGroup: false,
    } satisfies XmppMessage;

    expect(actionsLookLikeApproval(message.body, quickResponses, [])).toBe(true);
    expect(approvalFallbackExpiry(message, quickResponses, []))
      .toBe(new Date(timestamp).getTime() + 30 * 60_000);
  });

  it('does not assign the approval fallback to ordinary quick responses', () => {
    const message = {
      id: 'question-1',
      from: 'agent@example.org',
      to: 'me@example.org',
      type: 'chat',
      body: 'Elige un color',
      timestamp: '2026-07-18T12:00:00.000Z',
      direction: 'in',
      isGroup: false,
    } satisfies XmppMessage;
    const responses = [{ label: 'Azul', value: 'blue' }];

    expect(actionsLookLikeApproval(message.body, responses, [])).toBe(false);
    expect(approvalFallbackExpiry(message, responses, [])).toBeUndefined();
  });

  it('does not confuse submission acknowledgement with resolution', () => {
    expect(classifyApprovalCommandResult('Command submitted.')).toBe('submitted');
    expect(classifyApprovalCommandResult('Command expired.')).toBe('expired');
    expect(classifyApprovalCommandResult('Approval already resolved.')).toBe('expired');
    expect(classifyApprovalCommandResult('Failed to submit approval')).toBe('rejected');
  });

  it('notifies actionable approvals but not approval acknowledgements', () => {
    const base = {
      id: 'notification-1',
      from: 'agent@example.org',
      to: 'me@example.org',
      type: 'chat',
      timestamp: '2026-07-18T12:00:00.000Z',
      direction: 'in',
      isGroup: false,
    } satisfies Omit<XmppMessage, 'body'>;
    expect(isXmppNotificationNoise({
      ...base,
      body: '✅ Approval allow-once submitted for opaque.',
    })).toBe(true);
    expect(isXmppNotificationNoise({
      ...base,
      body: 'Approval required',
      commands: [{ jid: 'agent@example.org', node: 'cmd:1', name: 'Allow Once' }],
    })).toBe(false);
  });
});
