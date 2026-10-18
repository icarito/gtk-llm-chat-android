/** Mensajes entrantes en vivo: carbons (XEP-0280) y chat/groupchat directos. */
import type { Element } from '@xmpp/xml';
import type { XmppMessage } from '@/types/xmpp';
import { XmppHistory } from '@/xmpp/XmppHistory';
import { decryptStanzaIfEncrypted } from '@/xmpp/decrypt';
import { CHAT_STATES_NS } from '@/xmpp/ns';
import {
  bareJid,
  bodyWithOob,
  extractDelayStamp,
  extractOobUrl,
  extractReply,
  extractStanzaId,
  parseActionMetadata,
  parseReplaceId,
  replyBody,
} from '@/xmpp/parse';
import {
  addPendingActions,
  classifyApprovalCommandResult,
  expireMatchingQuickResponses,
  resolvePendingCommandActionsForConversation,
} from '@/xmpp/actions';
import { applyIncomingCorrection } from '@/xmpp/corrections';
import { handleAnnotation, matchesTarget } from '@/xmpp/annotations';
import { addMessageToMap, historyExtra } from '@/xmpp/messages';
import { messages, rooms } from '@/xmpp/store';
import { isGroupJidEx, isOwnGroupchatEcho, messageMentionsBot } from '@/xmpp/muc';
import { setTyping } from '@/xmpp/typing';
import type { StanzaCtx } from '@/xmpp/session';

/** Ids ya vistos en esta sesión (dedupe de carbons/mensajes repetidos). */
let seenIds = new Set<string>();

export function resetInbound() {
  seenIds = new Set();
}

// getChildren filtrado por nombre (sin namespace) porque ltx en
// React Native puede no resolver xmlns correctamente.
function carbonWrapper(stanza: Element): Element | undefined {
  return [...stanza.getChildren('sent'), ...stanza.getChildren('received')][0];
}

export function isCarbon(stanza: Element): boolean {
  return carbonWrapper(stanza) !== undefined;
}

/** XEP-0280: Message Carbons. Usar sólo si `isCarbon(stanza)`. */
export async function handleCarbon(stanza: Element, ctx: StanzaCtx): Promise<void> {
  const { config } = ctx;
  const carbonCandidates = [...stanza.getChildren('sent'),
    ...stanza.getChildren('received')];
  const carbonForwarded = carbonCandidates[0];
  const isCarbonReceived = carbonCandidates[0]
    ? (carbonCandidates[0] as Element).name === 'received'
    : false;

  if (carbonForwarded) {
    const forwardedCandidates = carbonForwarded.getChildren('forwarded');
    const forwarded = forwardedCandidates[0];
    const msgCandidates = forwarded?.getChildren('message') ?? [];
    const message = msgCandidates[0];
    if (message) {
      const fromAttr = (message.attrs.from as string) || '';
      const toAttr = (message.attrs.to as string) || '';
      const fromBare = bareJid(fromAttr);
      const toBare = bareJid(toAttr);
      const direction: 'in' | 'out' = isCarbonReceived ? 'in' : 'out';
      const partnerJid = direction === 'out' ? toBare : fromBare;
      const senderJid = direction === 'out' ? config.jid : fromAttr;

      // XEP-0444/0424 hechas desde otro dispositivo nuestro (o recibidas en otro recurso).
      if (handleAnnotation(message, partnerJid, direction === 'out' ? config.jid : fromAttr, direction === 'out')) return;

      const { decryptedBody, wasEncrypted, decryptedMetadata, encryptionStatus } = await decryptStanzaIfEncrypted(message, senderJid);
      const rawBodyText = wasEncrypted ? (decryptedBody || '') : (replyBody(message) ?? message.getChildText('body') ?? '');
      const carbonBody = bodyWithOob(message, rawBodyText);

      if (carbonBody) {
        // A queued carbon normally carries XEP-0203 <delay/> on the outer
        // wrapper/forwarded node, not necessarily on the inner message.
        const delayTs = extractDelayStamp(message)
          ?? (forwarded ? extractDelayStamp(forwarded) : null)
          ?? extractDelayStamp(stanza)
          ?? new Date().toISOString();

        const msgId = (message.attrs.id as string) || `carbon-${Date.now()}`;

        if (seenIds.has(msgId)) return;
        seenIds.add(msgId);

        // XEP-0308 vía carbon: otro recurso propio ya vio esta
        // corrección resolver la pregunta — misma lógica que el
        // camino directo, sólo cambia de dónde sale la stanza.
        const replaceId = parseReplaceId(message);
        if (replaceId) {
          applyIncomingCorrection(partnerJid, replaceId, carbonBody, delayTs, encryptionStatus);
          return;
        }

        const actions = parseActionMetadata(message);
        const quickResponses = decryptedMetadata?.quickResponses || actions.quickResponses;
        const commands = decryptedMetadata?.commands || actions.commands;
        const replyTo = decryptedMetadata?.replyTo || extractReply(message);
        const oobUrl = decryptedMetadata?.oobUrl || extractOobUrl(message, carbonBody);

        const carbonMsg: XmppMessage = {
          id: msgId,
          from: fromBare,
          to: toBare,
          type: 'chat',
          body: carbonBody,
          timestamp: delayTs,
          direction,
          isGroup: false,
          quickResponses,
          commands,
          replyTo,
          oobUrl,
          wasEncrypted,
          encryptionStatus,
        };

        const wasCached = direction === 'in'
          ? await XmppHistory.hasMessage(
            partnerJid, carbonBody, direction, delayTs,
          ).catch(() => false)
          : false;
        // Mismo corte que en la rama de mensajes en vivo: durante la
        // puesta al día de una instalación nueva, los carbons que el
        // servidor reenvía no son novedades.
        const carbonCatchingUp = direction === 'in'
          ? await XmppHistory.isFreshInstall().catch(() => false)
          : false;
        addMessageToMap(carbonMsg, !wasCached && !carbonCatchingUp);
        if (direction === 'in') {
          addPendingActions(partnerJid, carbonMsg,
            carbonMsg.quickResponses ?? [], carbonMsg.commands ?? []);
        }
        expireMatchingQuickResponses(partnerJid, carbonBody, delayTs);
        XmppHistory.recordMessage(partnerJid, carbonBody, direction, delayTs, null,
          carbonMsg.quickResponses ?? null, carbonMsg.commands ?? null,
          msgId, carbonMsg.oobUrl ?? null,
          null, null, null, null,
          carbonMsg.encryptionStatus === 'encrypted', historyExtra(carbonMsg)).catch(() => {});
      }
    }
    return;
  }
}

export async function handleChatMessage(stanza: Element, ctx: StanzaCtx): Promise<void> {
  const { config, botNick } = ctx;
  const type = stanza.attrs.type;
  if (type !== 'chat' && type !== 'groupchat') return;

  const from = stanza.attrs.from as string | undefined;
  if (!from) return;

  const platformId = bareJid(from);
  // XEP-0444 / XEP-0424: no son burbujas, se agregan sobre el mensaje objetivo.
  if (handleAnnotation(stanza, platformId, from, false)) return;

  const { decryptedBody, wasEncrypted, decryptedMetadata, encryptionStatus } = await decryptStanzaIfEncrypted(stanza, from);
  // XEP-0461: el fallback de la cita no es parte del texto del mensaje.
  const rawBodyText = wasEncrypted ? (decryptedBody || '') : (replyBody(stanza) ?? stanza.getChildText('body') ?? '');
  const body = bodyWithOob(stanza, rawBodyText);

  // XEP-0085: los estados viajan en mensajes sin cuerpo (o junto a uno).
  // Un cuerpo real implica que el contacto dejó de "escribir".
  const composing = Boolean(stanza.getChild('composing', CHAT_STATES_NS));
  const stoppedTyping = ['active', 'paused', 'inactive', 'gone']
    .some((state) => Boolean(stanza.getChild(state, CHAT_STATES_NS)));
  if (composing || stoppedTyping || body) {
    setTyping(bareJid(from), composing && !body);
  }
  const ownNick = rooms.get(platformId)?.nick || botNick;
  const stanzaId = type === 'groupchat' ? extractStanzaId(stanza, platformId) : null;

  if (type === 'groupchat' && isOwnGroupchatEcho(from, ownNick)) {
    // El eco trae el stanza-id de la sala: es el id con el que los demás
    // reaccionarán a / retractarán nuestro mensaje.
    const id = stanza.attrs.id as string | undefined;
    if (id && stanzaId) {
      const list = messages.getConversation(platformId);
      const idx = list.findIndex((m) => m.direction === 'out' && matchesTarget(m, id));
      if (idx >= 0 && list[idx]!.stanzaId !== stanzaId) {
        const updated = [...list];
        updated[idx] = { ...updated[idx]!, stanzaId };
        messages.setConversation(platformId, updated);
        XmppHistory.setMucStanzaId(platformId, id, stanzaId).catch(() => {});
      }
    }
    return;
  }
  if (!body) return;

  // XEP-0308: el servidor resuelve una pregunta pendiente con una
  // corrección al <id> original (ver resolveQuestion() en xmpp.ts del
  // gateway) — se trata aparte, no como mensaje nuevo.
  const replaceId = parseReplaceId(stanza);
  if (replaceId) {
    applyIncomingCorrection(
      platformId,
      replaceId,
      body,
      extractDelayStamp(stanza) ?? new Date().toISOString(),
      encryptionStatus,
    );
    return;
  }

  // El ack puede llegar como stanza independiente (incluidos carbons de
  // una decisión tomada en GTK u otro Android), no necesariamente como
  // XEP-0308. Al aceptarse/expirar el comando ya no queda una aprobación
  // accionable en ningún cliente.
  if (classifyApprovalCommandResult(body) !== 'rejected') {
    resolvePendingCommandActionsForConversation(platformId);
  }

  const isGroup = type === 'groupchat' || isGroupJidEx(platformId, undefined);
  const isMention = !isGroup || messageMentionsBot(stanza, body, ownNick, config.jid);

  const actions = parseActionMetadata(stanza);
  const quickResponses = decryptedMetadata?.quickResponses || actions.quickResponses;
  const commands = decryptedMetadata?.commands || actions.commands;
  const replyTo = decryptedMetadata?.replyTo || extractReply(stanza);
  const oobUrl = decryptedMetadata?.oobUrl || extractOobUrl(stanza, body);

  const msg: XmppMessage = {
    id: (stanza.attrs.id as string) || `${Date.now()}`,
    from: platformId,
    to: config.jid,
    type: type as 'chat' | 'groupchat',
    body,
    timestamp: extractDelayStamp(stanza) ?? new Date().toISOString(),
    direction: 'in',
    isMention,
    isGroup,
    quickResponses,
    commands,
    replyTo,
    oobUrl,
    wasEncrypted,
    encryptionStatus,
    stanzaId,
    senderNick: type === 'groupchat' ? from.split('/')[1] : undefined,
  };

  if (seenIds.has(msg.id)) return;
  seenIds.add(msg.id);

  // On cold start Prosody can replay queued messages after the short
  // connection grace period. They still belong in the live view, but an
  // exact row already in SQLite proves they are not a new notification.
  const wasCached = await XmppHistory.hasMessage(
    platformId, msg.body, 'in', msg.timestamp,
  ).catch(() => false);
  // Instalación nueva: el servidor vuelca lo pendiente de CADA contacto y
  // la base vacía hace que wasCached sea siempre false, así que sin este
  // corte cada mensaje del volcado dispara su notificación. La ventana se
  // cierra sola pasada la puesta al día (ver XmppHistory).
  const catchingUp = await XmppHistory.isFreshInstall().catch(() => false);
  addMessageToMap(msg, !wasCached && !catchingUp);
  addPendingActions(platformId, msg, quickResponses, commands);
  // Cache it so the next catch-up starts from here instead of refetching.
  XmppHistory.recordMessage(
    platformId,
    msg.body,
    'in',
    msg.timestamp,
    null,
    quickResponses,
    commands,
    msg.id,
    msg.oobUrl ?? null,
    null,
    null,
    null,
    null,
    msg.encryptionStatus === 'encrypted',
    historyExtra(msg),
  ).catch(() => {});
}
