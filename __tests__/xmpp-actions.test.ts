import { parse } from 'ltx';
import {
  actionsLookLikeApproval,
  approvalFallbackExpiry,
  classifyApprovalCommandResult,
  findDenyAction,
  isRestoredActionStale,
  parseActionMetadata,
  parseInlineCommands,
  parseQuickResponses,
} from '@/xmpp/XmppService';
import { isXmppNotificationNoise } from '@/xmpp/notifications';
import type { XmppMessage, XmppPendingAction } from '@/types/xmpp';

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

describe('restauración de acciones pendientes', () => {
  const MINUTE = 60 * 1000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it('respeta expiresAtMs explícito por encima de la antigüedad', () => {
    // Vieja pero con expiry futuro explícito => sigue viva.
    expect(isRestoredActionStale(iso(60 * MINUTE), {
      expiresAtMs: Date.now() + 5 * MINUTE,
    })).toBe(false);
    // Reciente pero ya vencida por expiry explícito => muerta.
    expect(isRestoredActionStale(iso(MINUTE), {
      expiresAtMs: Date.now() - MINUTE,
    })).toBe(true);
  });

  it('cae a la antigüedad de 15 min cuando no hay expiresAtMs', () => {
    expect(isRestoredActionStale(iso(5 * MINUTE), {})).toBe(false);
    expect(isRestoredActionStale(iso(20 * MINUTE), {})).toBe(true);
  });

  it('conserva la acción cuando el timestamp no es fechable', () => {
    // Conservador a propósito: preferimos una tarjeta de más que perder una
    // aprobación que el gateway todavía espera.
    expect(isRestoredActionStale('no-es-una-fecha', {})).toBe(false);
  });
});

describe('findDenyAction (gesto de deslizar al costado)', () => {
  const action = (over: Partial<XmppPendingAction>): XmppPendingAction => ({
    id: 'a', conversationJid: 'x@y', messageId: 'm', timestamp: new Date().toISOString(),
    detail: '', kind: 'command', label: 'Allow Once', ...over,
  } as XmppPendingAction);

  it('prefiere el estilo danger aunque la etiqueta no sea reconocible', () => {
    // Etiqueta deliberadamente opaca (localizada, o redactada por el servidor):
    // si la detección por estilo se rompe, NINGUNA regla de etiqueta la salva y
    // el test falla. Con "Deny" como etiqueta el caso pasaría por el fallback y
    // no probaría nada.
    const actions = [
      action({ id: '1', label: 'Verweigern', style: 'danger' }),
      action({ id: '2', label: 'Allow Once', style: 'success' }),
    ];
    expect(findDenyAction(actions)?.id).toBe('1');
  });

  it('el estilo gana sobre una etiqueta negativa en otra acción', () => {
    const actions = [
      action({ id: '1', label: 'No, gracias' }),
      action({ id: '2', label: 'Verweigern', style: 'danger' }),
    ];
    expect(findDenyAction(actions)?.id).toBe('2');
  });

  it('nunca devuelve una acción de aprobación si no hay ninguna negativa', () => {
    const actions = [
      action({ id: '1', label: 'Allow Once', style: 'success' }),
      action({ id: '2', label: 'Allow Always', style: 'success' }),
    ];
    expect(findDenyAction(actions)).toBeNull();
  });

  it('reconoce etiquetas negativas sin estilo', () => {
    expect(findDenyAction([action({ id: '1', label: 'Denegar' })])?.id).toBe('1');
    expect(findDenyAction([action({ id: '1', label: 'Rechazar' })])?.id).toBe('1');
  });

  it('no confunde "Allow" con una negación por contener otra palabra', () => {
    const actions = [action({ id: '1', label: 'Allow Once, no prompt' })];
    expect(findDenyAction(actions)).toBeNull();
  });
});
