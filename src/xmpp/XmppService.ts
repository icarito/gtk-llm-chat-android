/**
 * XMPP Service — singleton connection manager that survives React component
 * mounts/unmounts. The XMPP connection lives for the entire app lifecycle.
 * React components subscribe via listeners, never own the connection.
 */
import { client, xml } from '@xmpp/client';
import type { Client, Element } from '@xmpp/xml';
import type {
  DataForm,
  XmppAccountConfig,
  XmppButtonStyle,
  XmppConnectionState,
  XmppContact,
  XmppInlineCommand,
  XmppMessage,
  XmppPendingAction,
  XmppQuickResponse,
} from '@/types/xmpp';
import {
  dismissNotificationForJid,
  getStoredExpoPushToken,
  notifyXmppMessage,
  updateContactNameCache,
} from '@/xmpp/notifications';
import { PushStatus } from '@/xmpp/pushStatus';
import { ForegroundService } from '@/xmpp/ForegroundService';
import { XmppHistory, type HistoryRow } from '@/xmpp/XmppHistory';
import { buildFormElement } from '@/xmpp/xep-0004';
import { markdownToPlain } from '@/xmpp/outbound-render';

// ── Utils ──

function bareJid(full: string): string {
  return full.split('/')[0] ?? full;
}

function isGroupJidEx(barejid: string, mucDomain?: string): boolean {
  if (!mucDomain) return false;
  return barejid.endsWith(`@${mucDomain}`);
}

/**
 * Whether a conversation is a MUC. We have no configured MUC domain and rooms
 * never appear in the RFC 6121 roster, so the signal is a message we already
 * saw arrive (or were sent) as groupchat. Matters for MAM: a room's archive
 * lives on the room JID, not in the account's own archive.
 */
function isGroupConversation(bareJid: string): boolean {
  const messages = messagesMap.get(bareJid);
  if (!messages) return false;
  return messages.some((m) => m.type === 'groupchat' || m.isGroup);
}

function parseCaps(stanza: Element): string | null {
  const c = stanza.getChild('c', 'http://jabber.org/protocol/caps');
  if (!c) return null;
  return (c.attrs.node as string) || null;
}

function messageMentionsBot(stanza: Element, body: string, nick: string, jid: string): boolean {
  const refs = stanza.getChildren('reference');
  for (const ref of refs) {
    if (ref.attrs.type === 'mention') {
      const uri = (ref.attrs.uri as string) || '';
      if (uri.includes(jid) || uri.toLowerCase().includes(nick.toLowerCase())) return true;
    }
  }
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w@])@?${escaped}\\b`, 'i').test(body);
}

function extractReply(stanza: Element): { text: string; sender: string } | null {
  const reply = stanza.getChild('reply', 'urn:xmpp:reply:0');
  if (!reply) return null;
  const fallback = stanza.getChild('fallback', 'urn:xmpp:fallback:0');
  const fallbackText = fallback ? fallback.getChildText('body') || '' : '';
  const to = (reply.attrs.to as string) || '';
  return { text: fallbackText, sender: to ? bareJid(to) : 'unknown' };
}

/**
 * XEP-0203 delayed-delivery stamp, if present. A message replayed by the server
 * (offline queue) or by a room on join carries the original send time here;
 * without it we would stamp it "now" and it would sort to the bottom of the
 * conversation and fall outside the ±30s window the MAM reconciler uses.
 */
function extractDelayStamp(stanza: Element): string | null {
  const delay = stanza.getChild('delay', 'urn:xmpp:delay');
  const stamp = delay?.attrs.stamp as string | undefined;
  if (!stamp) return null;
  const t = new Date(stamp).getTime();
  return Number.isNaN(t) ? null : stamp;
}

function extractOobUrl(stanza: Element, body: string): string | null {
  const x = stanza.getChild('x', 'jabber:x:oob');
  const url = x?.getChildText('url');
  if (url) return url;
  const trimmed = body.trim();
  if (/^https?:\/\/\S+$/.test(trimmed)) return trimmed;
  return null;
}

const QUICK_RESPONSE_NS = 'urn:xmpp:quick-response:0';
const LEGACY_QUICK_RESPONSE_NS = 'urn:xmpp:tmp:quick-response';
const MESSAGE_CORRECT_NS = 'urn:xmpp:message-correct:0';
const DISCO_ITEMS_NS = 'http://jabber.org/protocol/disco#items';
const COMMAND_NS = 'http://jabber.org/protocol/commands';
const PUBSUB_EVENT_NS = 'http://jabber.org/protocol/pubsub#event';
const PUSH_NS = 'urn:xmpp:push:0';
const EXPO_PUSH_SERVICE_JID = 'expo-push.hablar.fuentelibre.org';
// Telemetría del agente (contexto, tokens, coste, modelo). Va por PEP y no en el
// <status> de la presencia: el status es texto para humanos —cualquier cliente lo
// pinta tal cual junto al contacto— y estos números cambian a cada token.
// El nodo lo fija el servidor del agente (proyecto renombrado de NanoClaw a
// OpenClaw), no nosotros — ver TELEMETRY_NODE en src/channels/xmpp.ts del
// gateway. Un agente aún no migrado sigue publicando bajo el nodo legacy.
const TELEMETRY_NODE = 'urn:openclaw:telemetry:0';
const LEGACY_TELEMETRY_NODE = 'urn:nanoclaw:telemetry:0';
const DISCO_INFO_NS = 'http://jabber.org/protocol/disco#info';

const CAPS_NODE = 'https://github.com/icarito/gtk-llm-chat-android';

/**
 * Lo que anunciamos por disco#info (y, resumido, por XEP-0115 caps).
 *
 * `<nodo>+notify` es notificación filtrada (XEP-0163): el servidor SÓLO nos
 * entrega los eventos PEP de los nodos que pedimos aquí. Sin esta línea el
 * agente publica su telemetría y nosotros no recibimos nada — no hay error, no
 * hay stanza, simplemente no llega.
 */
const CAPS_FEATURES = [DISCO_INFO_NS, `${TELEMETRY_NODE}+notify`, `${LEGACY_TELEMETRY_NODE}+notify`];
const pushLog = globalThis.console;

function normalizeButtonStyle(raw: unknown): XmppButtonStyle | undefined {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return s === 'primary' || s === 'secondary' || s === 'success' || s === 'danger' ? s : undefined;
}

function parseExpiresAtMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function parseQuickResponses(stanza: Element): XmppQuickResponse[] {
  const responses: XmppQuickResponse[] = [];
  for (const namespace of [QUICK_RESPONSE_NS, LEGACY_QUICK_RESPONSE_NS]) {
    for (const child of stanza.getChildren('response', namespace)) {
      const value = child.attrs.value as string | undefined;
      const label = (child.attrs.label as string | undefined) || value;
      if (value && label) {
        const style = normalizeButtonStyle(child.attrs.style);
        const expiresAtMs = parseExpiresAtMs(child.attrs['expires-at-ms']);
        responses.push({ value, label, ...(style ? { style } : {}), ...(expiresAtMs !== undefined ? { expiresAtMs } : {}) });
      }
    }
    for (const reference of stanza.getChildren('reference', namespace)) {
      if (reference.attrs.type !== 'action') continue;
      for (const body of reference.getChildren('body')) {
        const value = body.text();
        if (value) responses.push({ value, label: value });
      }
    }
  }
  return responses;
}

/**
 * XEP-0308: id del mensaje que esta stanza corrige, si trae <replace>.
 * El servidor envía esto cuando una pregunta con quick-responses/commands
 * se resuelve por cualquier vía (ver resolveQuestion() en xmpp.ts del
 * gateway) — null si el mensaje no es una corrección.
 */
export function parseReplaceId(stanza: Element): string | null {
  const replace = stanza.getChild('replace', MESSAGE_CORRECT_NS);
  return (replace?.attrs.id as string | undefined) || null;
}

export function parseInlineCommands(stanza: Element): XmppInlineCommand[] {
  const commands: XmppInlineCommand[] = [];
  for (const query of stanza.getChildren('query', DISCO_ITEMS_NS)) {
    if (query.attrs.node !== COMMAND_NS) continue;
    for (const item of query.getChildren('item')) {
      const jid = item.attrs.jid as string | undefined;
      const node = item.attrs.node as string | undefined;
      const name = item.attrs.name as string | undefined;
      const style = normalizeButtonStyle(item.attrs.style);
      if (jid && node && name) commands.push({ jid, node, name, ...(style ? { style } : {}) });
    }
  }
  return commands;
}

/**
 * Extrae la telemetría del <telemetry/> publicado en el nodo PEP.
 * Espejo de parse_telemetry() en xmpp_client.py del cliente GTK.
 *
 * El payload que emite el gateway anida los números en atributos, no en texto:
 *
 *   <telemetry xmlns='urn:nanoclaw:telemetry:0'>
 *     <context used='42000' max='128000'/>
 *     <tokens total='…' input='…' output='…' requests='…'/>
 *     <cost usd='0.0431'/>
 *     <model>deepseek-v4-pro</model>
 *     <tool>bash</tool>
 *   </telemetry>
 *
 * Nunca inventa ceros: "sin dato" y "cero" son cosas distintas para una barra de
 * progreso, así que una clave ausente se queda ausente.
 */
export function parseTelemetry(item: Element): Record<string, unknown> {
  const telemetry: Record<string, unknown> = {};
  const tlm = item.getChild('telemetry', TELEMETRY_NODE) ?? item.getChild('telemetry', LEGACY_TELEMETRY_NODE);
  if (!tlm) return telemetry;

  const intAttr = (node: Element | undefined, attr: string): number | undefined => {
    const val = node?.attrs[attr] as string | undefined;
    if (val === undefined || val === '') return undefined;
    const n = Number(val);
    return Number.isFinite(n) ? n : undefined;
  };

  // El contexto sólo sirve por pares: un `used` sin `max` (o con max=0) no da
  // fracción que pintar, así que se descarta entero en vez de publicar la mitad.
  const context = tlm.getChild('context');
  const used = intAttr(context, 'used');
  const max = intAttr(context, 'max');
  if (used !== undefined && max) {
    telemetry.context_used = used;
    telemetry.context_max = max;
  }

  const tokens = tlm.getChild('tokens');
  if (tokens) {
    for (const key of ['total', 'input', 'output', 'requests'] as const) {
      const value = intAttr(tokens, key);
      if (value !== undefined) telemetry[`tokens_${key}`] = value;
    }
  }

  const cost = Number(tlm.getChild('cost')?.attrs.usd);
  if (Number.isFinite(cost)) telemetry.cost = cost;

  for (const tag of ['model', 'tool'] as const) {
    const text = tlm.getChildText(tag);
    if (text) telemetry[tag] = text;
  }

  return telemetry;
}

/**
 * Unwrap one <result xmlns='urn:xmpp:mam:2'><forwarded><message/></forwarded>
 * into an XmppMessage. Returns null for archived stanzas with no body
 * (chat states, receipts), which the archive also stores.
 */
export function parseMamResult(mamResult: Element, ownJid: string, ownNick?: string): XmppMessage | null {
  const forwarded = mamResult.getChild('forwarded', 'urn:xmpp:forward:0');
  if (!forwarded) return null;
  const message = forwarded.getChild('message');
  if (!message) return null;

  const body = message.getChildText('body') || '';
  if (!body) return null;

  const fromAttr = (message.attrs.from as string) || '';
  const toAttr = (message.attrs.to as string) || '';
  const fromBare = bareJid(fromAttr);
  const toBare = bareJid(toAttr);
  const ownBare = bareJid(ownJid);
  const type = (message.attrs.type as 'chat' | 'groupchat') || 'chat';

  // The archive holds both sides of the conversation. Ours are the ones we
  // sent — the only reliable way to tell them apart on replay.
  //
  // In a room, the `from` is `room@domain/nick`, never our bare JID, so a
  // groupchat message is "out" only when the sender nick matches ours. Without
  // this, every message we posted comes back marked "in" and duplicates the
  // live "out" row (it can never reconcile against it).
  const direction: 'in' | 'out' = type === 'groupchat'
    ? (ownNick && fromAttr.split('/')[1] === ownNick ? 'out' : 'in')
    : (fromBare === ownBare ? 'out' : 'in');

  // <delay> carries the original send time; without it the message would be
  // stamped "now" and sort to the bottom of the conversation.
  const delay = forwarded.getChild('delay', 'urn:xmpp:delay');
  const timestamp = (delay?.attrs.stamp as string) || new Date().toISOString();

  const mamId = (mamResult.attrs.id as string) || '';

  return {
    id: (message.attrs.id as string) || mamId || `mam-${timestamp}`,
    mamId: mamId || null,
    from: fromBare,
    to: toBare,
    type,
    body,
    timestamp,
    direction,
    isGroup: type === 'groupchat',
    quickResponses: parseQuickResponses(message),
    commands: parseInlineCommands(message),
    replyTo: extractReply(message),
    oobUrl: extractOobUrl(message, body),
  };
}

// ── Listener types ──

export type XmppStateListener = (state: XmppConnectionState) => void;
export type XmppContactListener = (contacts: XmppContact[]) => void;
export type XmppMessageListener = (messages: Map<string, XmppMessage[]>) => void;
export type XmppPendingActionListener = (actions: XmppPendingAction[]) => void;

// ── Service state ──

let xmppClient: Client | null = null;
let connectionState: XmppConnectionState = 'disconnected';
let contactsMap = new Map<string, XmppContact>();
let messagesMap = new Map<string, XmppMessage[]>();
let pendingActions = new Map<string, XmppPendingAction>();
let accountConfig: XmppAccountConfig | null = null;
let seenIds = new Set<string>();
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectPromise: Promise<void> | null = null;
/** bare JID -> the set of their resources currently announcing availability. */
let onlineResources = new Map<string, Set<string>>();

/** PEP telemetry cache: bare_jid -> telemetry dict parsed from pubsub events. */
const agentTelemetry = new Map<string, Record<string, unknown>>();

export type AgentTelemetryListener = (jid: string, telemetry: Record<string, unknown>) => void;
const telemetryListeners = new Set<AgentTelemetryListener>();

function notifyTelemetry(jid: string, telemetry: Record<string, unknown>) {
  telemetryListeners.forEach((fn) => fn(jid, telemetry));
}

/**
 * In-flight MAM queries, keyed by queryid.
 *
 * XEP-0313 does NOT return results inside the IQ reply. The server sends each
 * archived message as its own <message><result queryid=...><forwarded> stanza
 * BEFORE the IQ result, which carries only <fin> + RSM paging info. So the
 * stanza handler buffers hits here by queryid, and the IQ promise only tells
 * us the query finished. Same design as the GTK client's _pending_mam_queries.
 */
const pendingMamQueries = new Map<string, XmppMessage[]>();

const stateListeners = new Set<XmppStateListener>();
const contactListeners = new Set<XmppContactListener>();
const messageListeners = new Set<XmppMessageListener>();
const pendingActionListeners = new Set<XmppPendingActionListener>();

function notifyState() {
  stateListeners.forEach((fn) => fn(connectionState));
}

function notifyContacts() {
  const arr = [...contactsMap.values()];
  updateContactNameCache(arr);
  contactListeners.forEach((fn) => fn(arr));
}

function notifyMessages() {
  // Return a NEW Map each time so React detects changes
  const copy = new Map(messagesMap);
  messageListeners.forEach((fn) => fn(copy));
}

function notifyPendingActions() {
  pendingActionListeners.forEach((fn) => fn([...pendingActions.values()]));
}

function expireMatchingQuickResponses(conversationJid: string, body: string, msgTimestamp: string) {
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

function addMessageToMap(msg: XmppMessage) {
  // Conversations are keyed by the OTHER party, whichever way the message went.
  const key = msg.direction === 'out' ? msg.to : msg.from;
  if (!key) return;
  const existing = messagesMap.get(key) || [];
  messagesMap.set(key, [...existing, msg]);
  notifyMessages();

  if (msg.direction === 'out') {
    expireMatchingQuickResponses(key, msg.body, msg.timestamp);
  } else {
    const contact = contactsMap.get(msg.from);
    notifyXmppMessage(msg, contact?.name);
  }
}

function addPendingActions(
  conversationJid: string,
  msg: XmppMessage,
  quickResponsesIn: XmppQuickResponse[],
  commandsIn: XmppInlineCommand[],
) {
  const timestampMs = new Date(msg.timestamp).getTime();
  const detail = markdownToPlain(msg.body ?? '');
  const now = Date.now();
  // Descartar quick-responses ya caducados por expiresAtMs explícito.
  const liveQr = quickResponsesIn.filter((r) => r.expiresAtMs === undefined || r.expiresAtMs > now);
  // Preferir command-items (IQ) sobre quick-responses (texto) cuando llegan
  // ambos (paridad con el GTK): no dejar el `value` crudo visible.
  const commands = commandsIn;
  const quickResponses = commands.length > 0 ? [] : liveQr;
  quickResponses.forEach((response, index) => {
    const id = `${msg.id}:qr:${index}:${response.value}`;
    pendingActions.set(id, {
      id,
      conversationJid,
      messageId: msg.id,
      timestamp: msg.timestamp,
      detail,
      kind: 'quick-response',
      label: response.label,
      value: response.value,
      ...(response.style ? { style: response.style } : {}),
      ...(response.expiresAtMs !== undefined ? { expiresAtMs: response.expiresAtMs } : {}),
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
      kind: 'command',
      label: command.name,
      jid: command.jid,
      node: command.node,
      ...(command.style ? { style: command.style } : {}),
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

function removePendingAction(id: string) {
  if (pendingActions.delete(id)) notifyPendingActions();
}

function removePendingActionsByMessage(conversationJid: string, messageId: string) {
  let changed = false;
  for (const [id, action] of pendingActions) {
    if (action.conversationJid === conversationJid && action.messageId === messageId) {
      pendingActions.delete(id);
      changed = true;
    }
  }
  if (changed) notifyPendingActions();
}

/**
 * XEP-0308 correction resolving a pending question: clears its card from
 * memory and from the local cache, and dismisses any notification it may
 * have posted. Server-authoritative — unlike the own-carbon heuristic
 * (expireMatchingQuickResponses), this carries the real replaceId so it
 * works no matter which question it resolves, not just the newest one.
 */
function applyIncomingCorrection(conversationJid: string, replaceId: string, body: string) {
  removePendingActionsByMessage(conversationJid, replaceId);
  XmppHistory.applyCorrectionByStanzaId(conversationJid, replaceId, body).catch(() => {});
  dismissNotificationForJid(conversationJid).catch(() => {});
}

function noteText(command: Element): string {
  const notes = command.getChildren('note');
  const parts = notes.map((note) => note.text()).filter(Boolean);
  return parts.join('\n') || 'Command completed.';
}

async function executeCommand(targetJid: string, node: string, form?: DataForm): Promise<string> {
  if (!xmppClient || connectionState !== 'online') {
    throw new Error('XMPP not connected');
  }

  const first = await xmppClient.iqCaller.request(
    xml(
      'iq',
      { type: 'set', to: targetJid, id: `cmd-${Date.now().toString(36)}` },
      xml('command', { xmlns: COMMAND_NS, node, action: 'execute' }),
    ),
    30000,
  );
  let command = first.getChild('command', COMMAND_NS);
  if (!command) throw new Error('Invalid command response');
  if (command.attrs.status === 'completed') return noteText(command);
  if (!form) throw new Error('Command requires a form submission');

  const sessionid = command.attrs.sessionid as string | undefined;
  if (!sessionid) throw new Error('Command did not return a session id');

  const second = await xmppClient.iqCaller.request(
    xml(
      'iq',
      { type: 'set', to: targetJid, id: `cmd-submit-${Date.now().toString(36)}` },
      xml('command', { xmlns: COMMAND_NS, node, sessionid, action: 'complete' }, buildFormElement(form)),
    ),
    30000,
  );
  command = second.getChild('command', COMMAND_NS);
  if (!command) throw new Error('Invalid command submit response');
  return noteText(command);
}

// ── XEP-0199 Ping ──

async function pingServer(jid: string, timeoutMs = 15000): Promise<void> {
  if (!xmppClient) throw new Error('XMPP not connected');
  await xmppClient.iqCaller.request(
    xml('iq', { type: 'get', to: jid, id: `ping-${Date.now()}` }, xml('ping', { xmlns: 'urn:xmpp:ping' })),
    timeoutMs,
  );
}

async function enableExpoPushIfAvailable(): Promise<void> {
  if (!xmppClient || connectionState !== 'online') return;

  const token = await getStoredExpoPushToken();
  if (!token) {
    PushStatus.update({ registration: 'idle', error: null });
    pushLog.warn('[xmpp-push] No stored Expo push token yet; skipping XEP-0357 registration');
    return;
  }

  PushStatus.update({ registration: 'pending', error: null });
  await xmppClient.iqCaller.request(
    xml(
      'iq',
      { type: 'set', id: `push-enable-${Date.now()}` },
      xml('enable', {
        xmlns: PUSH_NS,
        jid: EXPO_PUSH_SERVICE_JID,
        node: token,
      }),
    ),
    15000,
  );
  PushStatus.update({ registration: 'registered', error: null });
  pushLog.warn(`[xmpp-push] XEP-0357 registered with ${EXPO_PUSH_SERVICE_JID}`);
}

function startPing(jid: string) {
  stopPing();
  pingTimer = setInterval(async () => {
    if (!xmppClient) return;
    try {
      await pingServer(jid);
    } catch {
      await xmppClient.stop().catch(() => {});
      connectionState = 'offline';
      notifyState();
    }
  }, 55000);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// ── XEP-0313 MAM engine ──

/** Match GTK: re-query a week back so local live-cache rows are reconciled with MAM. */
const OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
/** Page size, and a ceiling so a misbehaving archive can't loop us forever. */
const MAM_PAGE_SIZE = 50;
const MAX_MAM_PAGES = 40;

/**
 * syncHistory runs on every screen mount/reconnect with no gate of its own —
 * re-opening the same chat a few times in a row (or a flaky connection
 * bouncing online/offline) would issue a fresh MAM IQ each time even though
 * nothing new has arrived. force=true (explicit pull-to-refresh) always
 * bypasses this.
 */
const SYNC_HISTORY_COOLDOWN_MS = 60 * 1000;
const lastSyncAt = new Map<string, number>();

interface MamPage {
  messages: XmppMessage[];
  complete: boolean;
  last: string | null;
}

/**
 * Run one MAM page query and resolve once the server closes it with <fin>.
 *
 * The results themselves do not come back from this IQ — they arrive as
 * separate <message> stanzas that the stanza handler drops into
 * pendingMamQueries[queryid]. The IQ reply only carries completeness and the
 * RSM cursor. Hence: register the buffer, send, await, collect, unregister.
 */
async function runMamQuery(
  contactJid: string,
  opts: { start?: string; end?: string; after?: string; latest?: boolean } = {},
): Promise<MamPage> {
  if (!xmppClient || !accountConfig) return { messages: [], complete: true, last: null };

  const queryid = `mam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const buffer: XmppMessage[] = [];
  pendingMamQueries.set(queryid, buffer);

  // A room archives its own history; the account archive holds only 1:1 chats.
  // For a MUC we therefore address the IQ TO the room and drop `with` (every
  // message in the room is "with" the room). For 1:1 we address our own server
  // (no `to`) and scope by `with`.
  const isGroup = isGroupConversation(contactJid);

  const fields: Element[] = [
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'urn:xmpp:mam:2')),
  ];
  if (!isGroup) {
    // Scope the query to this conversation; without `with`, the server returns
    // the account's entire archive.
    fields.push(xml('field', { var: 'with' }, xml('value', {}, contactJid)));
  }
  if (opts.start) fields.push(xml('field', { var: 'start' }, xml('value', {}, opts.start)));
  if (opts.end) fields.push(xml('field', { var: 'end' }, xml('value', {}, opts.end)));

  const rsm: Element[] = [xml('max', {}, String(MAM_PAGE_SIZE))];
  if (opts.after) rsm.push(xml('after', {}, opts.after));
  // Paging backwards (scroll-to-load-older or cold cache bootstrap) wants the
  // newest page of the range. Without this, MAM returns the oldest page first.
  if ((opts.end || opts.latest) && !opts.after) rsm.push(xml('before', {}));

  const iqAttrs: Record<string, string> = { type: 'set' };
  // Route a room query to the room's own archive; a 1:1 query has no `to` and
  // hits our account server.
  if (isGroup) iqAttrs.to = contactJid;

  try {
    const reply = await xmppClient.iqCaller.request(
      xml('iq', iqAttrs,
        xml('query', { xmlns: 'urn:xmpp:mam:2', queryid },
          xml('x', { xmlns: 'jabber:x:data', type: 'submit' }, ...fields),
          xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, ...rsm),
        ),
      ),
      30000,
    );

    const fin = reply.getChild('fin', 'urn:xmpp:mam:2');
    const set = fin?.getChild('set', 'http://jabber.org/protocol/rsm');
    return {
      messages: [...buffer],
      complete: fin?.attrs.complete === 'true',
      last: set?.getChildText('last') || null,
    };
  } catch {
    return { messages: [...buffer], complete: true, last: null };
  } finally {
    pendingMamQueries.delete(queryid);
  }
}

/**
 * Persist a batch of archived messages, dropping the ones we already have, and
 * return only what was genuinely new (oldest first).
 *
 * A message we sent or received live is already cached with no mam_id. When it
 * comes back from the archive it carries one, so it would not collide on
 * UNIQUE(bare_jid, mam_id) and would render a second time — attach the id to
 * the existing row instead.
 */
async function persistAndDedupe(contactJid: string, messages: XmppMessage[]): Promise<XmppMessage[]> {
  const fresh: XmppMessage[] = [];
  for (const msg of messages) {
    const mamId = msg.mamId ?? null;
    // msg.id es el stanza id real del <message> en los tres caminos
    // (en vivo, MAM, carbon) — es el mismo id que una corrección XEP-0308
    // futura usará en su <replace id=...>. Sólo tiene sentido guardarlo
    // si trae algo que luego pueda resolverse.
    const hasPending = Boolean(msg.quickResponses?.length || msg.commands?.length);
    const stanzaId = hasPending ? msg.id : null;
    if (mamId && await XmppHistory.attachMamToRecentMessage(
      contactJid,
      msg.body,
      msg.direction,
      msg.timestamp,
      mamId,
      msg.quickResponses ?? null,
      msg.commands ?? null,
      stanzaId,
    )) {
      continue;
    }
    const inserted = await XmppHistory.recordMessage(
      contactJid,
      msg.body,
      msg.direction,
      msg.timestamp,
      mamId,
      msg.quickResponses ?? null,
      msg.commands ?? null,
      stanzaId,
    );
    if (inserted) fresh.push(msg);
  }
  fresh.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return fresh;
}

/** Rehydrate a cached row into the shape the UI renders. */
function rowToMessage(row: HistoryRow, contactJid: string): XmppMessage {
  const ownJid = accountConfig?.jid ?? '';
  return {
    id: row.stanza_id || row.mam_id || `cache-${row.direction}-${row.timestamp}`,
    mamId: row.mam_id,
    from: row.direction === 'out' ? ownJid : contactJid,
    to: row.direction === 'out' ? contactJid : ownJid,
    type: 'chat',
    body: row.body,
    timestamp: row.timestamp,
    direction: row.direction,
    isGroup: false,
    quickResponses: row.quick_responses,
    commands: row.commands,
    oobUrl: row.oob_url,
  };
}

// Edad máxima para restaurar una acción pendiente que NO trae expiresAtMs
// explícito. El registro de comandos del servidor caduca a los 15 min
// (command-node-registry DEFAULT_TTL_MS), así que una tarjeta más vieja ya
// está muerta en el servidor y no debe re-renderizarse al reabrir el cliente.
// Paridad con el GTK (_PENDING_ACTION_MAX_AGE_MS).
const PENDING_ACTION_MAX_AGE_MS = 15 * 60 * 1000;

/** True si la acción caducó (por expiresAtMs explícito, o por antigüedad si no lo trae). */
function isRestoredActionStale(timestamp: string, action: { expiresAtMs?: number } | XmppInlineCommand): boolean {
  const now = Date.now();
  const expiresAtMs = (action as { expiresAtMs?: number }).expiresAtMs;
  if (expiresAtMs !== undefined) return expiresAtMs <= now;
  const ts = new Date(timestamp).getTime();
  if (!Number.isFinite(ts)) return false; // no se puede fechar: conservador, no descartar
  return now - ts > PENDING_ACTION_MAX_AGE_MS;
}

async function restorePendingQuickResponses(contactJid: string, messages: XmppMessage[]): Promise<void> {
  for (const msg of messages) {
    const quickResponses = msg.quickResponses ?? [];
    const commands = msg.commands ?? [];
    if (quickResponses.length === 0 && commands.length === 0) continue;

    // Descartar acciones caducadas (por expiresAtMs o por antigüedad > 15 min).
    const freshQr = quickResponses.filter((r) => !isRestoredActionStale(msg.timestamp, r));
    const freshCmd = commands.filter((c) => !isRestoredActionStale(msg.timestamp, c));
    if (freshQr.length === 0 && freshCmd.length === 0) continue;

    if (freshQr.length > 0) {
      const values = freshQr.map((response) => response.value || response.label).filter(Boolean);
      if (await XmppHistory.quickResponseWasAnswered(contactJid, msg.timestamp, values)) continue;
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

// ── Public API ──

export const XmppService = {
  getState(): XmppConnectionState {
    return connectionState;
  },

  getContacts(): XmppContact[] {
    return [...contactsMap.values()];
  },

  getMessages(): Map<string, XmppMessage[]> {
    return new Map(messagesMap);
  },

  getPendingActions(): XmppPendingAction[] {
    return [...pendingActions.values()];
  },

  getAccount(): XmppAccountConfig | null {
    return accountConfig;
  },

  onStateChange(fn: XmppStateListener) {
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
  },

  onContactsChange(fn: XmppContactListener) {
    contactListeners.add(fn);
    return () => contactListeners.delete(fn);
  },

  onMessagesChange(fn: XmppMessageListener) {
    messageListeners.add(fn);
    return () => messageListeners.delete(fn);
  },

  onPendingActionsChange(fn: XmppPendingActionListener) {
    pendingActionListeners.add(fn);
    return () => pendingActionListeners.delete(fn);
  },

  getAgentTelemetry(bareJid: string): Record<string, unknown> | undefined {
    return agentTelemetry.get(bareJid);
  },

  onTelemetry(fn: AgentTelemetryListener) {
    telemetryListeners.add(fn);
    return () => telemetryListeners.delete(fn);
  },

  /**
   * Pide el valor actual del nodo de telemetría del agente.
   *
   * Los eventos PEP sólo llegan cuando el agente *publica* algo nuevo, así que
   * un agente que lleva rato quieto no emitiría nada y la barra de contexto se
   * quedaría vacía para siempre. Al abrir la conversación preguntamos por el
   * último valor publicado (el nodo guarda max_items=1).
   */
  async fetchAgentTelemetry(bareJid: string): Promise<void> {
    if (!xmppClient || connectionState !== 'online') return;
    // Probar primero el nodo actual (OpenClaw) y, si el agente aún no migró
    // y ese nodo no existe, reintentar con el legacy (NanoClaw) antes de
    // rendirse — ver el rename documentado junto a TELEMETRY_NODE arriba.
    for (const node of [TELEMETRY_NODE, LEGACY_TELEMETRY_NODE]) {
      try {
        const result = await xmppClient.iqCaller.request(
          xml(
            'iq',
            { type: 'get', to: bareJid },
            xml(
              'pubsub',
              { xmlns: 'http://jabber.org/protocol/pubsub' },
              xml('items', { node, max_items: '1' }),
            ),
          ),
          10000,
        );
        const items = result
          .getChild('pubsub', 'http://jabber.org/protocol/pubsub')
          ?.getChild('items')
          ?.getChildren('item') ?? [];
        for (const item of items) {
          const telemetry = parseTelemetry(item);
          if (Object.keys(telemetry).length > 0) {
            agentTelemetry.set(bareJid, telemetry);
            notifyTelemetry(bareJid, telemetry);
            return;
          }
        }
      } catch {
        // Lo normal si el contacto no es un agente, o si no tiene este nodo
        // en particular (probamos el otro namespace a continuación).
      }
    }
  },

  async connect(config: XmppAccountConfig) {
    if (xmppClient) {
      await this.disconnect();
    }

    connectionState = 'connecting';
    notifyState();
    accountConfig = config;
    seenIds = new Set();
    contactsMap = new Map();
    messagesMap = new Map();
    pendingActions = new Map();
    notifyPendingActions();
    // Reset, or a reconnect keeps phantom "online" resources from the old
    // session and the offline->online flip never registers.
    onlineResources = new Map();

    const botNick = config.jid.split('@')[0]!;
    const domain = config.jid.split('@')[1];

    xmppClient = client({
      service: config.service,
      domain,
      username: config.jid.split('@')[0],
      password: config.password,
      resource: `${config.resource || 'gtk-llm-chat-android'}-${Math.random().toString(36).slice(2, 10)}`,
    });

    xmppClient.reconnect.on('reconnecting', () => {
      xmppClient!.reconnect.delay = 5000;
    });

    // XEP-0115 caps. El `ver` NO es el hash SHA-1 que manda la spec: es un
    // identificador opaco de este conjunto de features. No hay SHA-1 en el bundle
    // de RN (ni una dependencia de cripto que valga la pena arrastrar por esto).
    //
    // Funciona porque el servidor cachea por node#ver y, cuando ve un ver que no
    // conoce, nos pregunta por disco#info al recurso completo — y eso sí lo
    // respondemos (handler de iq/get más abajo). Prosody no valida el hash.
    //
    // OJO, DOS TRAMPAS, y las dos fallan EN SILENCIO (no llega telemetría, sin
    // error ni stanza de aviso):
    //  1. Si cambias CAPS_FEATURES, SUBE ESTA VERSIÓN. Un servidor que cacheó el
    //     ver anterior no vuelve a preguntar y los features nuevos no se anuncian.
    //  2. Si algún día el servidor sí verifica el hash, esto deja de funcionar y
    //     habrá que calcular el ver de verdad (el gateway lo hace en
    //     capsVerHash(), src/channels/xmpp.ts) — con una implementación de SHA-1.
    const capsHash = 'v2-telemetry';
    const capsNode = CAPS_NODE;

    xmppClient.on('online', () => {
      connectionState = 'online';
      notifyState();
      ForegroundService.start(config.jid).catch(() => {});

      // XEP-0280 Carbons — usar iqCaller para asegurar delivery y tener id
      xmppClient!.iqCaller.request(
        xml('iq', { type: 'set', id: `carbons-${Date.now()}` },
          xml('enable', { xmlns: 'urn:xmpp:carbons:2' })),
        10000,
      ).catch(() => {});
      enableExpoPushIfAvailable().catch((error) => {
        PushStatus.update({
          registration: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        pushLog.warn('[xmpp-push] XEP-0357 registration failed', error);
      });

      // XEP-0199 Ping
      startPing(config.jid);

      // RFC 6121 order: roster FIRST, initial presence only once it lands.
      // Announcing presence makes the server immediately push every contact's
      // presence back at us — if contactsMap is still empty at that moment,
      // the presence handler drops all of it (it only updates known contacts)
      // and the server never resends, leaving every contact stuck offline.
      xmppClient!.iqCaller.request(
        xml('iq', { type: 'get' }, xml('query', { xmlns: 'jabber:iq:roster' })),
        15000,
      ).then((result) => {
        const items = result.getChild('query', 'jabber:iq:roster')?.getChildren('item') ?? [];
        const ownBare = bareJid(config.jid);
        // Rebuild from scratch: the roster query is authoritative, and a stale
        // entry from a previous connection must not survive it.
        contactsMap = new Map();
        for (const item of items) {
          const jid = (item.attrs.jid as string) || '';
          if (!jid || bareJid(jid) === ownBare) continue;
          const sub = (item.attrs.subscription as string) || 'none';
          contactsMap.set(jid, {
            jid,
            name: (item.attrs.name as string) || jid,
            subscription: sub as XmppContact['subscription'],
            // Unknown until a <presence> arrives — same as the GTK client.
            presence: 'offline',
            status: undefined,
            caps: undefined,
          });
        }
        notifyContacts();
      }).catch(() => {}).then(() => {
        // Send it even if the roster query failed: without initial presence the
        // server won't route incoming messages to us at all.
        xmppClient?.send(xml('presence', {}, xml('c', {
          xmlns: 'http://jabber.org/protocol/caps',
          hash: 'sha-1',
          node: capsNode,
          ver: capsHash,
        }))).catch(() => {});
      });
    });

    xmppClient.on('offline', () => {
      connectionState = 'offline';
      notifyState();
      stopPing();
    });

    xmppClient.on('error', () => {
      connectionState = 'error';
      notifyState();
    });

    xmppClient.on('stanza', (stanza: Element) => {
      // ── XEP-0030: alguien pregunta qué soportamos ──
      // El servidor lo pregunta cuando ve un caps `ver` que no tiene cacheado.
      // Es el único momento en que puede enterarse de que queremos el nodo de
      // telemetría con +notify; si no contestamos, no nos manda los eventos PEP.
      if (stanza.is('iq') && stanza.attrs.type === 'get') {
        const query = stanza.getChild('query', DISCO_INFO_NS);
        if (query) {
          const from = stanza.attrs.from as string | undefined;
          const id = stanza.attrs.id as string | undefined;
          // Devolvemos el mismo `node` que nos preguntaron (o ninguno): un
          // disco#info a un node concreto debe responder por ese node.
          const node = query.attrs.node as string | undefined;
          xmppClient!.send(
            xml(
              'iq',
              { type: 'result', ...(from ? { to: from } : {}), ...(id ? { id } : {}) },
              xml(
                'query',
                { xmlns: DISCO_INFO_NS, ...(node ? { node } : {}) },
                xml('identity', { category: 'client', type: 'phone', name: 'gtk-llm-chat-android' }),
                ...CAPS_FEATURES.map((feature) => xml('feature', { var: feature })),
              ),
            ),
          ).catch(() => {});
          return;
        }
      }

      // ── Presence ──
      if (stanza.is('presence')) {
        const ptype = stanza.attrs.type;
        const from = stanza.attrs.from as string | undefined;
        if (!from) return;
        const bare = bareJid(from);

        if (ptype === 'subscribe') {
          xmppClient!.send(xml('presence', { to: bare, type: 'subscribed' }));
          xmppClient!.send(xml('presence', { to: bare, type: 'subscribe' }));
          return;
        }
        if (ptype === 'unsubscribe') {
          xmppClient!.send(xml('presence', { to: bare, type: 'unsubscribed' }));
          return;
        }
        // Only available/unavailable say anything about presence. Anything else
        // (subscribed, error, …) must not be read as a status change.
        if (ptype !== undefined && ptype !== 'unavailable') return;

        // The roster is whatever the RFC 6121 query returned — presence only
        // UPDATES those entries, it never creates new ones. Otherwise our own
        // account (a second client on another resource, e.g. the GTK app)
        // sends us presence and ends up listed as one of our own contacts.
        const existing = contactsMap.get(bare);
        if (!existing) return;

        // A contact is online if ANY of their resources is. Tracking them
        // individually matters when they're logged in from two clients: one
        // going away must not mark the whole contact offline.
        const resource = from.split('/')[1] ?? '';
        const resources = onlineResources.get(bare) ?? new Set<string>();
        if (ptype === 'unavailable') {
          resources.delete(resource);
        } else {
          resources.add(resource);
        }
        onlineResources.set(bare, resources);

        const status = stanza.getChildText('status') || undefined;
        const caps = parseCaps(stanza);

        contactsMap.set(bare, {
          ...existing,
          // Available presence carries no `type` at all; <show> only refines it
          // (away/dnd), so its absence means online — not unknown.
          presence: resources.size > 0 ? 'online' : 'offline',
          status: status ?? existing.status,
          caps: caps || existing.caps,
        });
        notifyContacts();
        return;
      }

      // ── XEP-0163 PEP PubSub events (agent telemetry) ──
      const pubsubEvent = stanza.getChild('event', PUBSUB_EVENT_NS);
      if (pubsubEvent) {
        const items = pubsubEvent.getChild('items');
        const node = items?.attrs.node as string | undefined;
        if (node === TELEMETRY_NODE || node === LEGACY_TELEMETRY_NODE) {
          const from = stanza.attrs.from as string | undefined;
          if (!from) return;
          const bare = bareJid(from);
          for (const item of items?.getChildren('item') ?? []) {
            const telemetry = parseTelemetry(item);
            if (Object.keys(telemetry).length > 0) {
              agentTelemetry.set(bare, telemetry);
              notifyTelemetry(bare, telemetry);
            }
          }
          return;
        }
        // Other pubsub nodes are ignored.
        return;
      }

      // ── Messages ──
      if (!stanza.is('message')) return;

      // ── XEP-0313: archived message delivered for an in-flight query ──
      // These arrive as type-less <message> wrappers with no <body> of their
      // own, so they must be handled before the chat/groupchat filter below.
      const mamResult = stanza.getChild('result', 'urn:xmpp:mam:2');
      if (mamResult) {
        const queryid = (mamResult.attrs.queryid as string) || '';
        const buffer = pendingMamQueries.get(queryid);
        if (!buffer) return;
        const parsed = parseMamResult(mamResult, config.jid, botNick);
        if (parsed) buffer.push(parsed);
        return;
      }

      // ── XEP-0280: Message Carbons ──
      // getChildren filtrado por nombre (sin namespace) porque ltx en
      // React Native puede no resolver xmlns correctamente.
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
          const carbonBody = message.getChildText('body') || '';
          if (carbonBody) {
            const fromAttr = (message.attrs.from as string) || '';
            const toAttr = (message.attrs.to as string) || '';
            const delayTs = extractDelayStamp(message) ?? new Date().toISOString();

            const fromBare = bareJid(fromAttr);
            const toBare = bareJid(toAttr);
            const direction: 'in' | 'out' = isCarbonReceived ? 'in' : 'out';
            const partnerJid = direction === 'out' ? toBare : fromBare;
            const msgId = (message.attrs.id as string) || `carbon-${Date.now()}`;

            if (seenIds.has(msgId)) return;
            seenIds.add(msgId);

            // XEP-0308 vía carbon: otro recurso propio ya vio esta
            // corrección resolver la pregunta — misma lógica que el
            // camino directo, sólo cambia de dónde sale la stanza.
            const replaceId = parseReplaceId(message);
            if (replaceId) {
              applyIncomingCorrection(partnerJid, replaceId, carbonBody);
              return;
            }

            const carbonMsg: XmppMessage = {
              id: msgId,
              from: fromBare,
              to: toBare,
              type: 'chat',
              body: carbonBody,
              timestamp: delayTs,
              direction,
              isGroup: false,
              quickResponses: parseQuickResponses(message),
              commands: parseInlineCommands(message),
              replyTo: extractReply(message),
              oobUrl: extractOobUrl(message, carbonBody),
            };

            addMessageToMap(carbonMsg);
            if (direction === 'in') {
              addPendingActions(partnerJid, carbonMsg,
                carbonMsg.quickResponses ?? [], carbonMsg.commands ?? []);
            }
            expireMatchingQuickResponses(partnerJid, carbonBody, delayTs);
            const carbonHasPending = Boolean(
              carbonMsg.quickResponses?.length || carbonMsg.commands?.length);
            XmppHistory.recordMessage(partnerJid, carbonBody, direction, delayTs, null,
              carbonMsg.quickResponses ?? null, carbonMsg.commands ?? null,
              carbonHasPending ? msgId : null, carbonMsg.oobUrl ?? null).catch(() => {});
          }
        }
        return;
      }

      const type = stanza.attrs.type;
      if (type !== 'chat' && type !== 'groupchat') return;

      const body = stanza.getChildText('body') || '';
      const from = stanza.attrs.from as string | undefined;
      if (!from) return;
      if (!body) return;

      const platformId = bareJid(from);

      if (type === 'groupchat') {
        const senderNick = from.split('/')[1];
        if (senderNick === botNick) return;
      }

      // XEP-0308: el servidor resuelve una pregunta pendiente con una
      // corrección al <id> original (ver resolveQuestion() en xmpp.ts del
      // gateway) — se trata aparte, no como mensaje nuevo.
      const replaceId = parseReplaceId(stanza);
      if (replaceId) {
        applyIncomingCorrection(platformId, replaceId, body);
        return;
      }

      const isGroup = type === 'groupchat' || isGroupJidEx(platformId, undefined);
      const isMention = !isGroup || messageMentionsBot(stanza, body, botNick, config.jid);
      const quickResponses = parseQuickResponses(stanza);
      const commands = parseInlineCommands(stanza);

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
        replyTo: extractReply(stanza),
        oobUrl: extractOobUrl(stanza, body),
      };

      if (seenIds.has(msg.id)) return;
      seenIds.add(msg.id);

      addMessageToMap(msg);
      addPendingActions(platformId, msg, quickResponses, commands);
      // Cache it so the next catch-up starts from here instead of refetching.
      const hasPending = Boolean(quickResponses.length || commands.length);
      XmppHistory.recordMessage(
        platformId,
        msg.body,
        'in',
        msg.timestamp,
        null,
        quickResponses,
        commands,
        hasPending ? msg.id : null,
        msg.oobUrl ?? null,
      ).catch(() => {});
    });

    try {
      await xmppClient.start();
    } catch (err) {
      connectionState = 'error';
      notifyState();
      throw err;
    }
  },

  async reconnectIfNeeded(config: XmppAccountConfig) {
    const mergedConfig: XmppAccountConfig = {
      jid: config.jid || accountConfig?.jid || '',
      password: config.password || accountConfig?.password || '',
      service: config.service || accountConfig?.service || '',
      resource: config.resource || accountConfig?.resource || 'gtk-llm-chat-android',
    };
    if (!mergedConfig.jid || !mergedConfig.password || !mergedConfig.service) {
      throw new Error('XMPP account config incomplete for reconnect');
    }
    accountConfig = mergedConfig;

    if (reconnectPromise) return reconnectPromise;
    if (connectionState === 'connecting') return;

    if (xmppClient && connectionState === 'online') {
      try {
        await pingServer(mergedConfig.jid, 5000);
        return;
      } catch {
        connectionState = 'offline';
        notifyState();
      }
    }

    reconnectPromise = (async () => {
      stopPing();
      if (xmppClient) {
        await xmppClient.stop().catch(() => {});
        xmppClient = null;
      }
      await this.connect(mergedConfig);
    })().finally(() => {
      reconnectPromise = null;
    });

    return reconnectPromise;
  },

  async disconnect() {
    stopPing();
    if (xmppClient) {
      await xmppClient.stop().catch(() => {});
      xmppClient = null;
    }
    await ForegroundService.stop().catch(() => {});
    connectionState = 'disconnected';
    notifyState();
    pendingActions = new Map();
    notifyPendingActions();
    accountConfig = null;
  },

  async sendMessage(to: string, body: string, type: 'chat' | 'groupchat' = 'chat'): Promise<string> {
    if (!xmppClient || connectionState !== 'online') {
      throw new Error('XMPP not connected');
    }
    const id = `nc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = new Date().toISOString();
    // Add outgoing message to map immediately
    addMessageToMap({
      id,
      from: accountConfig?.jid ?? '',
      to,
      type,
      body,
      timestamp,
      direction: 'out',
      isGroup: type === 'groupchat',
    });
    await xmppClient.send(xml('message', { type, to, id }, xml('body', {}, body)));
    // Cached with no mam_id; the archive copy will be matched onto this row.
    XmppHistory.recordMessage(to, body, 'out', timestamp, null).catch(() => {});
    return id;
  },

  async answerPendingAction(actionId: string): Promise<void> {
    const action = pendingActions.get(actionId);
    if (!action) return;
    if (action.kind === 'quick-response') {
      await this.sendMessage(action.conversationJid, action.value ?? action.label, 'chat');
    } else if (action.jid && action.node) {
      await executeCommand(action.jid, action.node);
    }
    XmppHistory.markResolvedByStanzaId(action.conversationJid, action.messageId).catch(() => {});
    removePendingActionsByMessage(action.conversationJid, action.messageId);
    removePendingAction(actionId);
  },

  async listAdhocCommands(targetJid: string): Promise<XmppInlineCommand[]> {
    if (!xmppClient || connectionState !== 'online') {
      throw new Error('XMPP not connected');
    }
    const result = await xmppClient.iqCaller.request(
      xml(
        'iq',
        { type: 'get', to: targetJid, id: `disco-items-${Date.now().toString(36)}` },
        xml('query', { xmlns: DISCO_ITEMS_NS, node: COMMAND_NS }),
      ),
      15000,
    );
    const query = result.getChild('query', DISCO_ITEMS_NS);
    if (!query) return [];
    const commands: XmppInlineCommand[] = [];
    for (const item of query.getChildren('item')) {
      const jid = (item.attrs.jid as string) || targetJid;
      const node = item.attrs.node as string | undefined;
      const name = (item.attrs.name as string | undefined) || node;
      if (!node || !name) continue;
      commands.push({ jid, node, name });
    }
    return commands;
  },

  async runAdhocCommand(targetJid: string, node: string): Promise<string> {
    return executeCommand(targetJid, node);
  },

  async setApprovalBypass(targetJid: string, enabled: boolean, minutes = 15): Promise<string> {
    return executeCommand(targetJid, 'approval-bypass', {
      type: 'submit',
      fields: [
        { var: 'mode', type: 'list-single', value: enabled ? 'on' : 'off' },
        { var: 'minutes', type: 'text-single', value: String(minutes) },
      ],
    });
  },

  async sendTyping(to: string) {
    if (!xmppClient || connectionState !== 'online') return;
    try {
      await xmppClient.send(
        xml('message', { type: 'chat', to }, xml('composing', { xmlns: 'http://jabber.org/protocol/chatstates' })),
      );
    } catch {
      // best effort
    }
  },

  isConnected(): boolean {
    return connectionState === 'online' && xmppClient !== null;
  },

  // ── XEP-0313: MAM history ──

  /**
   * Messages already cached locally — render these immediately, before any
   * network round-trip.
   */
  async loadCachedHistory(
    contactJid: string,
    limit = 50,
    opts: { restoreActions?: boolean } = {},
  ): Promise<XmppMessage[]> {
    const rows = await XmppHistory.getRecent(contactJid, limit);
    const history = rows.map((row) => rowToMessage(row, contactJid));
    if (opts.restoreActions ?? true) {
      await restorePendingQuickResponses(contactJid, history);
    }
    return history;
  },

  async restoreCachedActions(contactJid: string, limit = 50): Promise<void> {
    const rows = await XmppHistory.getRecent(contactJid, limit);
    await restorePendingQuickResponses(contactJid, rows.map((row) => rowToMessage(row, contactJid)));
  },

  /**
   * One cached preview per roster item, used by the conversation list before
   * the user opens a chat or MAM catch-up has completed.
   */
  async loadCachedPreviews(contactJids: string[]): Promise<Map<string, XmppMessage>> {
    const rows = await XmppHistory.getLatestForContacts(contactJids);
    const previews = new Map<string, XmppMessage>();
    for (const row of rows) {
      const current = previews.get(row.bare_jid);
      if (!current || new Date(row.timestamp).getTime() >= new Date(current.timestamp).getTime()) {
        previews.set(row.bare_jid, rowToMessage(row, row.bare_jid));
      }
    }
    return previews;
  },

  /**
   * Catch up on everything the archive has that our cache doesn't, then persist
   * and return it (oldest first).
   *
   * Pages forward until the archive says it is complete. This is not optional:
   * when the range holds more messages than one page, MAM returns the OLDEST
   * page first with complete=false. A single un-paged query therefore yields
   * the oldest messages and silently omits the recent ones — the exact bug the
   * GTK client hit (see load_history_from_mam in xmpp_client.py).
   */
  async syncHistory(contactJid: string, force = false): Promise<XmppMessage[]> {
    if (!xmppClient || connectionState !== 'online' || !accountConfig) return [];

    if (!force) {
      const last = lastSyncAt.get(contactJid);
      if (last && Date.now() - last < SYNC_HISTORY_COOLDOWN_MS) return [];
    }
    lastSyncAt.set(contactJid, Date.now());

    // Cold cache: pull the newest page and stop. Older pages come on scroll.
    const latestTs = await XmppHistory.getLatestTimestamp(contactJid);
    if (!latestTs) {
      const result = await runMamQuery(contactJid, { latest: true });
      return persistAndDedupe(contactJid, result.messages);
    }

    // Incremental catch-up: page forward from the last archived message we
    // hold, using its RSM UID as the `after` cursor. This asks the server only
    // for what is genuinely newer than our cache — no re-downloading a fixed
    // time window on every open (the old 7-day overlap fetched up to a full
    // week of history each time, which the dedupe then silently discarded).
    const latestMamId = await XmppHistory.getLatestMamId(contactJid);

    // Fallback only when the cache holds no archived message at all (e.g. it
    // was populated purely by live messages that never reconciled). Then we
    // have no cursor, so re-fetch a bounded window by time to seed one.
    const start = latestMamId
      ? undefined
      : new Date(new Date(latestTs).getTime() - OVERLAP_MS).toISOString();

    const collected: XmppMessage[] = [];
    let after: string | undefined = latestMamId ?? undefined;

    for (let page = 0; page < MAX_MAM_PAGES; page++) {
      const result = await runMamQuery(contactJid, { start, after });
      collected.push(...result.messages);
      if (result.complete || !result.last) break;
      // RSM `last` is an archive UID, not a timestamp — it is the cursor for
      // the next page, and must be passed through verbatim.
      after = result.last;
    }

    return persistAndDedupe(contactJid, collected);
  },

  /**
   * The page of messages older than `beforeTimestamp` — for scroll-to-load.
   * Serves from cache when possible, otherwise reaches into the archive with
   * an `end=` filter.
   */
  async loadOlderHistory(contactJid: string, beforeTimestamp: string, limit = 50): Promise<XmppMessage[]> {
    const cached = await XmppHistory.getBefore(contactJid, beforeTimestamp, limit);
    if (cached.length > 0) {
      return cached.map((row) => rowToMessage(row, contactJid));
    }
    if (!xmppClient || connectionState !== 'online' || !accountConfig) return [];

    const result = await runMamQuery(contactJid, { end: beforeTimestamp });
    return persistAndDedupe(contactJid, result.messages);
  },
};
