/**
 * Acciones pendientes: quick-responses (XEP-0066/tmp) y command-items
 * (XEP-0050) que el agente ofrece como tarjeta, su caducidad y su resolución.
 */
import type {
  XmppInlineCommand,
  XmppMessage,
  XmppPendingAction,
  XmppQuickResponse,
} from '@/types/xmpp';
import { dismissNotificationForJid } from '@/xmpp/notifications';
import { XmppHistory } from '@/xmpp/XmppHistory';
import { extractApprovalSummary, markdownToPlain } from '@/xmpp/outbound-render';
import { pendingActions as pendingStore } from '@/xmpp/store';

const pendingActions = pendingStore.map;
let pendingActionExpiryTimer: ReturnType<typeof setTimeout> | null = null;

/** Poda lo caducado, reprograma el timer de caducidad y publica el snapshot. */
export function notifyPendingActions() {
  pruneExpiredPendingActions();
  schedulePendingActionExpiry();
  pendingStore.commit();
}

/** Lectura síncrona (XmppService.getPendingActions): poda y devuelve una copia fresca. */
export function getPendingActions(): XmppPendingAction[] {
  pruneExpiredPendingActions();
  schedulePendingActionExpiry();
  return [...pendingActions.values()];
}

export function getPendingAction(id: string): XmppPendingAction | undefined {
  return pendingActions.get(id);
}

/** Descarta todas (nueva conexión / logout). */
export function clearPendingActions() {
  pendingActions.clear();
  notifyPendingActions();
}

export function isPendingActionExpired(action: XmppPendingAction, now = Date.now()): boolean {
  return action.expiresAtMs !== undefined && action.expiresAtMs <= now;
}

// OpenClaw keeps exec.approval.waitDecision pending for 30 minutes. A shorter
// client-only timeout hides the sole decision UI without resolving the gateway
// request, leaving every subsequent exec blocked as “approval already pending”.
const APPROVAL_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000;

export function bodyLooksLikeApproval(body: string): boolean {
  const text = body.toLowerCase();
  return text.includes('approval')
    || text.includes('aprobación')
    || text.includes('aprobacion')
    || text.includes('pending command')
    || text.includes('🔒');
}

export function actionsLookLikeApproval(
  body: string,
  quickResponses: XmppQuickResponse[],
  commands: XmppInlineCommand[],
): boolean {
  if (bodyLooksLikeApproval(body)) return true;
  const words = ['allow', 'approve', 'deny', 'reject', 'permitir', 'aprobar', 'denegar', 'rechazar'];
  const labels = [
    ...quickResponses.map((action) => action.label),
    ...commands.map((action) => action.name),
  ].map((label) => label.trim().toLowerCase());
  if (labels.some((label) => words.some((word) => label.includes(word)))) return true;
  return commands.some((action) => {
    const node = action.node.toLowerCase();
    return node.includes('approve') || node.includes('approval');
  });
}

/**
 * Mismo criterio que actionsLookLikeApproval, pero sobre XmppPendingAction[]
 * (la forma ya-aplanada que usa la tarjeta "pendiente" de la pantalla de
 * chat — label/node viven directo en cada item, no anidados en
 * quickResponses/commands separados). Distingue "Approval required"
 * (autorizar/denegar una acción del agente) de "Response needed" (una
 * pregunta cualquiera) — GTK ya hace esta distinción
 * (_actions_look_like_approval), Android la mostraba toda bajo el mismo
 * rótulo genérico.
 */
export function pendingGroupLooksLikeApproval(
  detail: string,
  actions: Pick<XmppPendingAction, 'label' | 'node'>[],
): boolean {
  if (bodyLooksLikeApproval(detail)) return true;
  const words = ['allow', 'approve', 'deny', 'reject', 'permitir', 'aprobar', 'denegar', 'rechazar'];
  const labels = actions.map((action) => action.label.trim().toLowerCase());
  if (labels.some((label) => words.some((word) => label.includes(word)))) return true;
  return actions.some((action) => {
    const node = (action.node ?? '').toLowerCase();
    return node.includes('approve') || node.includes('approval');
  });
}

export function approvalFallbackExpiry(
  msg: XmppMessage,
  quickResponses: XmppQuickResponse[],
  commands: XmppInlineCommand[],
): number | undefined {
  if (!actionsLookLikeApproval(msg.body, quickResponses, commands)) return undefined;
  const timestampMs = new Date(msg.timestamp).getTime();
  return (Number.isFinite(timestampMs) ? timestampMs : Date.now())
    + APPROVAL_FALLBACK_MAX_AGE_MS;
}

export function classifyApprovalCommandResult(
  result: string,
): 'submitted' | 'expired' | 'rejected' {
  const text = result.trim();
  if (/command expired\.?|already resolved|no longer pending|not found/i.test(text)) return 'expired';
  if (/command submitted\.?/i.test(text)) return 'submitted';
  if (/allow-once|allow-always|deny/i.test(text)) return 'submitted';
  if (/aprobado|denegado/i.test(text)) return 'submitted';
  return 'rejected';
}

export function pruneExpiredPendingActions(now = Date.now()): boolean {
  let changed = false;
  const expiredMessages = new Map<string, Set<string>>();
  for (const [id, action] of pendingActions) {
    if (isPendingActionExpired(action, now)) {
      pendingActions.delete(id);
      changed = true;
      const ids = expiredMessages.get(action.conversationJid) ?? new Set<string>();
      ids.add(action.messageId);
      expiredMessages.set(action.conversationJid, ids);
    }
  }
  // La card no debe resucitar desde SQLite al volver a la conversación. Una
  // sola pregunta puede aportar varios botones, por eso se deduplica por
  // conversación + messageId antes de limpiar su metadata.
  expiredMessages.forEach((messageIds, conversationJid) => {
    messageIds.forEach((messageId) => {
      XmppHistory.markResolvedByStanzaId(conversationJid, messageId).catch(() => {});
    });
  });
  return changed;
}

function schedulePendingActionExpiry() {
  if (pendingActionExpiryTimer) {
    clearTimeout(pendingActionExpiryTimer);
    pendingActionExpiryTimer = null;
  }
  const now = Date.now();
  const expiries = [...pendingActions.values()]
    .map((action) => action.expiresAtMs)
    .filter((value): value is number => value !== undefined && value > now);
  if (expiries.length === 0) return;
  const delay = Math.max(250, Math.min(...expiries) - now);
  pendingActionExpiryTimer = setTimeout(() => {
    pendingActionExpiryTimer = null;
    if (pruneExpiredPendingActions()) notifyPendingActions();
    else schedulePendingActionExpiry();
  }, delay);
}

export function expireMatchingQuickResponses(conversationJid: string, body: string, msgTimestamp: string) {
  const msgTime = new Date(msgTimestamp).getTime();
  let changed = false;
  for (const [id, action] of pendingActions) {
    if (action.conversationJid !== conversationJid) continue;
    if (action.kind !== 'quick-response') continue;
    const actionTime = new Date(action.timestamp).getTime();
    if (msgTime <= actionTime) continue;
    if (action.value === body || action.label === body) {
      pendingActions.delete(id);
      changed = true;
      // Señal secundaria (heurística por texto, más rápida que la
      // corrección XEP-0308 autoritativa) — persistimos ya mismo para
      // que un cierre de app antes de que llegue la corrección real no
      // resucite la card al reabrir (ver applyIncomingCorrection).
      XmppHistory.markResolvedByStanzaId(conversationJid, action.messageId).catch(() => {});
    }
  }
  if (changed) notifyPendingActions();
}

export function resolveApprovalActionsFromOwnMessage(conversationJid: string, body: string) {
  // A decision made by another resource arrives as an XEP-0280 sent carbon.
  // Approval cards prefer XEP-0050 commands, so the quick-response matcher
  // above cannot associate that plain /approve text with them. Retire the
  // command cards immediately; the authoritative XEP-0308 correction will
  // still replace the exact originating message when the gateway resolves.
  if (!/^\/approve\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s+(?:allow-once|allow-always|always|deny)\b/i.test(body.trim())) {
    return;
  }
  resolvePendingCommandActionsForConversation(conversationJid);
}

export function addPendingActions(
  conversationJid: string,
  msg: XmppMessage,
  quickResponsesIn: XmppQuickResponse[],
  commandsIn: XmppInlineCommand[],
) {
  const timestampMs = new Date(msg.timestamp).getTime();
  const isApproval = bodyLooksLikeApproval(msg.body ?? '')
    || actionsLookLikeApproval(msg.body ?? '', quickResponsesIn, commandsIn);
  const detail = isApproval
    ? extractApprovalSummary(msg.body ?? '')
    : markdownToPlain(msg.body ?? '');
  // Cuerpo íntegro para la vista expandida (gesto de arrastrar hacia arriba /
  // botón de info). Solo se guarda si aporta algo sobre el resumen: para una
  // approval incluye cwd y la expiración, que extractApprovalSummary descarta.
  const detailFullText = markdownToPlain(msg.body ?? '').trim();
  const detailFull = detailFullText && detailFullText !== detail.trim()
    ? detailFullText
    : undefined;
  const now = Date.now();
  const fallbackExpiry = approvalFallbackExpiry(msg, quickResponsesIn, commandsIn);
  // Descartar acciones ya caducadas por expiresAtMs explícito.
  const liveQr = quickResponsesIn.filter(
    (r) => (r.expiresAtMs ?? fallbackExpiry ?? Number.POSITIVE_INFINITY) > now,
  );
  const liveCommands = commandsIn.filter(
    (command) => (command.expiresAtMs ?? fallbackExpiry ?? Number.POSITIVE_INFINITY) > now,
  );
  // Preferir command-items (IQ) sobre quick-responses (texto) cuando llegan
  // ambos (paridad con el GTK): no dejar el `value` crudo visible.
  const commands = liveCommands;
  const quickResponses = commands.length > 0 ? [] : liveQr;
  quickResponses.forEach((response, index) => {
    const id = `${msg.id}:qr:${index}:${response.value}`;
    pendingActions.set(id, {
      id,
      conversationJid,
      messageId: msg.id,
      timestamp: msg.timestamp,
      detail,
      ...(detailFull ? { detailFull } : {}),
      kind: 'quick-response',
      label: response.label,
      value: response.value,
      ...(response.style ? { style: response.style } : {}),
      ...((response.expiresAtMs ?? fallbackExpiry) !== undefined
        ? { expiresAtMs: response.expiresAtMs ?? fallbackExpiry }
        : {}),
    });
  });
  commands.forEach((command, index) => {
    const id = `${msg.id}:cmd:${index}:${command.node}`;
    pendingActions.set(id, {
      id,
      conversationJid,
      messageId: msg.id,
      timestamp: msg.timestamp,
      detail,
      ...(detailFull ? { detailFull } : {}),
      kind: 'command',
      label: command.name,
      jid: command.jid,
      node: command.node,
      ...(command.style ? { style: command.style } : {}),
      ...((command.expiresAtMs ?? fallbackExpiry) !== undefined
        ? { expiresAtMs: command.expiresAtMs ?? fallbackExpiry }
        : {}),
    });
  });

  if (quickResponses.length > 0 || commands.length > 0) {
    const cutoff = timestampMs - 24 * 60 * 60 * 1000;
    for (const [id, action] of pendingActions) {
      if (new Date(action.timestamp).getTime() < cutoff) pendingActions.delete(id);
    }
    notifyPendingActions();
  }
}

export function removePendingAction(id: string) {
  if (pendingActions.delete(id)) notifyPendingActions();
}

export function removePendingActionsByMessage(conversationJid: string, messageId: string) {
  let changed = false;
  for (const [id, action] of pendingActions) {
    if (action.conversationJid === conversationJid && action.messageId === messageId) {
      pendingActions.delete(id);
      changed = true;
    }
  }
  if (changed) notifyPendingActions();
}

/** ¿Esta acción concreta es una decisión de aprobación?
 *
 *  Paridad con `_actions_look_like_approval` de GTK (chat_window.py:2833).
 *  El ack de una aprobación no dice CUÁL resolvió, así que retiramos por
 *  heurística; acotarla al subconjunto que parece approval evita arrastrar
 *  command-items inline que siguen siendo válidos. */
/**
 * La acción de denegar dentro de un grupo, para el gesto de deslizar al
 * costado. Se busca por estilo (el plugin marca Deny como `danger`) y sólo
 * después por etiqueta: NUNCA por posición, porque el orden lo decide el
 * servidor y un índice fijo acabaría aprobando lo que el usuario quería negar.
 * Devuelve null si no hay una acción claramente negativa — en ese caso el
 * gesto no debe hacer nada.
 */
export function findDenyAction(actions: XmppPendingAction[]): XmppPendingAction | null {
  const byStyle = actions.find((action) => action.style === 'danger');
  if (byStyle) return byStyle;
  const words = ['deny', 'reject', 'denegar', 'rechazar', 'no'];
  const byLabel = actions.find((action) => {
    const label = action.label.trim().toLowerCase();
    return words.some((word) => label === word || label.startsWith(`${word} `));
  });
  return byLabel ?? null;
}

export function actionLooksLikeApproval(action: XmppPendingAction): boolean {
  const words = ['allow', 'approve', 'deny', 'reject', 'permitir', 'aprobar', 'denegar', 'rechazar'];
  const label = (action.label ?? '').trim().toLowerCase();
  if (words.some((word) => label.includes(word))) return true;
  const node = (action.node ?? '').toLowerCase();
  return node.includes('approve') || node.includes('approval');
}

export function resolvePendingCommandActionsForConversation(conversationJid: string) {
  const messageIds = new Set<string>();
  for (const [id, action] of pendingActions) {
    if (action.conversationJid !== conversationJid || action.kind !== 'command') continue;
    // Antes se retiraba TODA command-action de la conversación. GTK filtra por
    // contenido y es el comportamiento correcto: un ack de aprobación no
    // invalida un comando inline que no es una aprobación.
    if (!actionLooksLikeApproval(action)) continue;
    messageIds.add(action.messageId);
    pendingActions.delete(id);
  }
  if (messageIds.size === 0) return;
  notifyPendingActions();
  messageIds.forEach((messageId) => {
    XmppHistory.markResolvedByStanzaId(conversationJid, messageId).catch(() => {});
  });
  dismissNotificationForJid(conversationJid).catch(() => {});
}

// Edad máxima para restaurar una acción pendiente que NO trae expiresAtMs
// explícito. El registro de comandos del servidor caduca a los 15 min
// (command-node-registry DEFAULT_TTL_MS), así que una tarjeta más vieja ya
// está muerta en el servidor y no debe re-renderizarse al reabrir el cliente.
// Paridad con el GTK (_PENDING_ACTION_MAX_AGE_MS).
const PENDING_ACTION_MAX_AGE_MS = 15 * 60 * 1000;

/** True si la acción caducó (por expiresAtMs explícito, o por antigüedad si no lo trae). */
export function isRestoredActionStale(timestamp: string, action: { expiresAtMs?: number } | XmppInlineCommand): boolean {
  const now = Date.now();
  const expiresAtMs = (action as { expiresAtMs?: number }).expiresAtMs;
  if (expiresAtMs !== undefined) return expiresAtMs <= now;
  const ts = new Date(timestamp).getTime();
  if (!Number.isFinite(ts)) return false; // no se puede fechar: conservador, no descartar
  return now - ts > PENDING_ACTION_MAX_AGE_MS;
}

export async function restorePendingQuickResponses(contactJid: string, messages: XmppMessage[]): Promise<void> {
  for (const msg of messages) {
    const quickResponses = msg.quickResponses ?? [];
    const commands = msg.commands ?? [];
    if (quickResponses.length === 0 && commands.length === 0) continue;

    // Descartar acciones caducadas (por expiresAtMs o por antigüedad > 15 min).
    const fallbackExpiry = approvalFallbackExpiry(msg, quickResponses, commands);
    const freshQr = quickResponses.filter((r) => !isRestoredActionStale(
      msg.timestamp, { ...r, expiresAtMs: r.expiresAtMs ?? fallbackExpiry },
    ));
    const freshCmd = commands.filter((c) => !isRestoredActionStale(
      msg.timestamp, { ...c, expiresAtMs: c.expiresAtMs ?? fallbackExpiry },
    ));
    if (freshQr.length === 0 && freshCmd.length === 0) {
      // NO borrar la metadata aquí. Caducado por reloj local ≠ resuelto en el
      // servidor: si el gateway sigue esperando la decisión, borrar
      // quick_responses/commands destruye el único registro de que hubo una
      // aprobación pendiente y la vuelve irrecuperable, incluso si más tarde
      // llega una corrección XEP-0308 o el usuario reinstala. Se omite el
      // render (la tarjeta no reaparece) pero la fila se conserva, que es lo
      // que ya hace el GTK (_restore_history_actions hace return sin borrar).
      // La limpieza real la hace answerPendingAction al resolver, o
      // applyIncomingCorrection cuando el servidor confirma el cierre.
      continue;
    }

    // ¿Ya se respondió? Se comprueba con los values de los quick-responses
    // (una respuesta deja un mensaje saliente con ese texto). OJO: un
    // command-item se contesta por IQ y NO deja rastro saliente, así que para
    // ellos esta comprobación no sirve — de ahí que se miren SIEMPRE los
    // values del mensaje, aunque luego se prefieran los comandos.
    const answerValues = quickResponses
      .map((response) => response.value || response.label)
      .filter(Boolean);
    if (answerValues.length > 0
      && await XmppHistory.quickResponseWasAnswered(contactJid, msg.timestamp, answerValues)) {
      // Resuelto: limpiar también el cache para que no vuelva a intentarlo.
      XmppHistory.markResolvedByStanzaId(contactJid, msg.id).catch(() => {});
      continue;
    }
    // Preferir command-items (IQ) sobre quick-responses (texto) cuando el
    // mensaje trae ambos — paridad con el GTK. Si hay comandos, se restauran
    // solo esos; si no, los quick-responses.
    if (freshCmd.length > 0) {
      addPendingActions(contactJid, msg, [], freshCmd);
    } else {
      addPendingActions(contactJid, msg, freshQr, []);
    }
  }
}
