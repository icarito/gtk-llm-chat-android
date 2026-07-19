import { actionLooksLikeApproval } from '@/xmpp/XmppService';
import type { XmppPendingAction } from '@/types/xmpp';

function action(overrides: Partial<XmppPendingAction>): XmppPendingAction {
  return {
    id: 'a1',
    conversationJid: 'agente@hablar.fuentelibre.org',
    messageId: 'oc-1',
    kind: 'command',
    label: 'Botón',
    createdAtMs: Date.now(),
    ...overrides,
  } as XmppPendingAction;
}

describe('filtro semántico del ack de aprobación', () => {
  it('reconoce decisiones de aprobación por la etiqueta', () => {
    for (const label of ['Allow Once', 'Deny', 'Permitir siempre', 'Rechazar', 'approve']) {
      expect(actionLooksLikeApproval(action({ label }))).toBe(true);
    }
  });

  it('reconoce aprobaciones por el nodo del comando', () => {
    expect(actionLooksLikeApproval(action({ label: 'Sí', node: 'approve:abc123' })))
      .toBe(true);
    expect(actionLooksLikeApproval(action({ label: 'Sí', node: 'exec-approval-7' })))
      .toBe(true);
  });

  it('NO arrastra comandos inline que no son aprobaciones', () => {
    // El caso que motivó el filtro: el ack de una aprobación retiraba TODA
    // command-action de la conversación, incluidas las que siguen válidas.
    expect(actionLooksLikeApproval(action({ label: 'Reiniciar sesión', node: 'cmd:reset' })))
      .toBe(false);
    expect(actionLooksLikeApproval(action({ label: 'Ver contexto', node: 'cmd:context' })))
      .toBe(false);
    expect(actionLooksLikeApproval(action({ label: 'Compactar', node: 'cmd:compact' })))
      .toBe(false);
  });

  it('tolera acciones sin etiqueta ni nodo', () => {
    expect(actionLooksLikeApproval(action({ label: '', node: undefined }))).toBe(false);
  });
});
