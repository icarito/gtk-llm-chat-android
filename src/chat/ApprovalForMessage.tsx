import { memo, useCallback, useMemo, useSyncExternalStore } from 'react';
import { Alert, Platform, ToastAndroid } from 'react-native';
import { ApprovalCard, type ApprovalButton } from '@/components/agent/ApprovalCard';
import { XmppService, pendingGroupLooksLikeApproval } from '@/xmpp/XmppService';
import { subscribeAgent } from '@/xmpp/agents';
import type { XmppPendingAction } from '@/types/xmpp';
import { usePendingActions } from './stores';

function toButton(action: XmppPendingAction): ApprovalButton {
  return {
    label: action.label,
    value: action.value,
    commandNode: action.node,
    commandJid: action.jid,
    style: action.style ?? 'primary',
    kind: action.kind === 'command' ? 'command' : 'quick',
  };
}

function notify(message: string) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert(message);
}

/**
 * Tarjeta de aprobación de UN mensaje. Se suscribe sólo a lo suyo: el hook
 * de aprobación de su stanza (snapshot estable por hook) y la lista de acciones
 * pendientes; el reloj vive dentro de ApprovalCard (un intervalo por tarjeta
 * visible, ninguno a nivel de pantalla).
 */
function ApprovalForMessageImpl({ jid, messageId, stanzaId }: {
  jid: string;
  messageId: string;
  stanzaId?: string | null;
}) {
  const all = usePendingActions();
  const actions = useMemo(
    () => all.filter((a) => a.conversationJid === jid && a.messageId === messageId),
    [all, jid, messageId],
  );
  const hook = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeAgent(jid, cb), [jid]),
    () => XmppService.approvalForStanza(jid, stanzaId ?? messageId),
  );

  const open = useMemo(() => actions.filter((a) => !a.submitted), [actions]);
  const onPress = useCallback((button: ApprovalButton) => {
    const action = open.find((a) => a.label === button.label);
    if (!action) return;
    XmppService.answerPendingAction(action.id).catch((err) => notify(String(err)));
  }, [open]);

  const decision = useMemo(
    () => (hook && hook.state ? { state: hook.state, decision: hook.decision } : undefined),
    [hook],
  );
  const buttons = useMemo(() => open.map(toButton), [open]);

  if (buttons.length === 0 && !decision) return null;
  const first = actions[0];
  const looksLikeApproval = first
    ? pendingGroupLooksLikeApproval(first.detailFull ?? first.detail, actions)
    : true;

  return (
    <ApprovalCard
      title={looksLikeApproval ? 'Se requiere aprobación' : 'Respuesta pendiente'}
      detail={first?.detail}
      command={hook?.command}
      buttons={buttons}
      expiresAtMs={first?.expiresAtMs ?? hook?.expiresAtMs}
      decision={decision}
      onPress={onPress}
    />
  );
}

export const ApprovalForMessage = memo(ApprovalForMessageImpl);
