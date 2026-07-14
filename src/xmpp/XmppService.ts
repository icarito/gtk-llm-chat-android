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
  XmppConnectionState,
  XmppContact,
  XmppInlineCommand,
  XmppMessage,
  XmppPendingAction,
  XmppQuickResponse,
} from '@/types/xmpp';
import { getStoredExpoPushToken, notifyXmppMessage } from '@/xmpp/notifications';
import { PushStatus } from '@/xmpp/pushStatus';
import { ForegroundService } from '@/xmpp/ForegroundService';
import { XmppHistory, type HistoryRow } from '@/xmpp/XmppHistory';
import { buildFormElement } from '@/xmpp/xep-0004';

// ── Utils ──

function bareJid(full: string): string {
  return full.split('/')[0] ?? full;
}

function isGroupJidEx(barejid: string, mucDomain?: string): boolean {
  if (!mucDomain) return false;
  return barejid.endsWith(`@${mucDomain}`);
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
const DISCO_ITEMS_NS = 'http://jabber.org/protocol/disco#items';
const COMMAND_NS = 'http://jabber.org/protocol/commands';
const PUSH_NS = 'urn:xmpp:push:0';
const EXPO_PUSH_SERVICE_JID = 'expo-push.hablar.fuentelibre.org';
const pushLog = globalThis.console;

export function parseQuickResponses(stanza: Element): XmppQuickResponse[] {
  const responses: XmppQuickResponse[] = [];
  for (const namespace of [QUICK_RESPONSE_NS, LEGACY_QUICK_RESPONSE_NS]) {
    for (const child of stanza.getChildren('response', namespace)) {
      const value = child.attrs.value as string | undefined;
      const label = (child.attrs.label as string | undefined) || value;
      if (value && label) responses.push({ value, label });
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

export function parseInlineCommands(stanza: Element): XmppInlineCommand[] {
  const commands: XmppInlineCommand[] = [];
  for (const query of stanza.getChildren('query', DISCO_ITEMS_NS)) {
    if (query.attrs.node !== COMMAND_NS) continue;
    for (const item of query.getChildren('item')) {
      const jid = item.attrs.jid as string | undefined;
      const node = item.attrs.node as string | undefined;
      const name = item.attrs.name as string | undefined;
      if (jid && node && name) commands.push({ jid, node, name });
    }
  }
  return commands;
}

/**
 * Unwrap one <result xmlns='urn:xmpp:mam:2'><forwarded><message/></forwarded>
 * into an XmppMessage. Returns null for archived stanzas with no body
 * (chat states, receipts), which the archive also stores.
 */
export function parseMamResult(mamResult: Element, ownJid: string): XmppMessage | null {
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

  // The archive holds both sides of the conversation. Ours are the ones we
  // sent, which is the only reliable way to tell them apart on replay.
  const direction: 'in' | 'out' = fromBare === ownBare ? 'out' : 'in';
  const type = (message.attrs.type as 'chat' | 'groupchat') || 'chat';

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

function addMessageToMap(msg: XmppMessage) {
  // Conversations are keyed by the OTHER party, whichever way the message went.
  const key = msg.direction === 'out' ? msg.to : msg.from;
  if (!key) return;
  const existing = messagesMap.get(key) || [];
  messagesMap.set(key, [...existing, msg]);
  notifyMessages();

  if (msg.direction === 'in') {
    const contact = contactsMap.get(msg.from);
    notifyXmppMessage(msg, contact?.name);
  }
}

function addPendingActions(
  conversationJid: string,
  msg: XmppMessage,
  quickResponses: XmppQuickResponse[],
  commands: XmppInlineCommand[],
) {
  const timestampMs = new Date(msg.timestamp).getTime();
  quickResponses.forEach((response, index) => {
    const id = `${msg.id}:qr:${index}:${response.value}`;
    pendingActions.set(id, {
      id,
      conversationJid,
      messageId: msg.id,
      timestamp: msg.timestamp,
      detail: msg.body,
      kind: 'quick-response',
      label: response.label,
      value: response.value,
    });
  });
  commands.forEach((command, index) => {
    const id = `${msg.id}:cmd:${index}:${command.node}`;
    pendingActions.set(id, {
      id,
      conversationJid,
      messageId: msg.id,
      timestamp: msg.timestamp,
      detail: msg.body,
      kind: 'command',
      label: command.name,
      jid: command.jid,
      node: command.node,
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

  const fields: Element[] = [
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'urn:xmpp:mam:2')),
    // Scope the query to this conversation; without `with`, the server returns
    // the account's entire archive.
    xml('field', { var: 'with' }, xml('value', {}, contactJid)),
  ];
  if (opts.start) fields.push(xml('field', { var: 'start' }, xml('value', {}, opts.start)));
  if (opts.end) fields.push(xml('field', { var: 'end' }, xml('value', {}, opts.end)));

  const rsm: Element[] = [xml('max', {}, String(MAM_PAGE_SIZE))];
  if (opts.after) rsm.push(xml('after', {}, opts.after));
  // Paging backwards (scroll-to-load-older or cold cache bootstrap) wants the
  // newest page of the range. Without this, MAM returns the oldest page first.
  if ((opts.end || opts.latest) && !opts.after) rsm.push(xml('before', {}));

  try {
    const reply = await xmppClient.iqCaller.request(
      xml('iq', { type: 'set' },
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
    if (mamId && await XmppHistory.attachMamToRecentMessage(
      contactJid,
      msg.body,
      msg.direction,
      msg.timestamp,
      mamId,
      msg.quickResponses ?? null,
      msg.commands ?? null,
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
    id: row.mam_id || `cache-${row.direction}-${row.timestamp}`,
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
  };
}

async function restorePendingQuickResponses(contactJid: string, messages: XmppMessage[]): Promise<void> {
  for (const msg of messages) {
    const quickResponses = msg.quickResponses ?? [];
    if (quickResponses.length === 0) continue;
    const values = quickResponses
      .map((response) => response.value || response.label)
      .filter(Boolean);
    if (await XmppHistory.quickResponseWasAnswered(msg.timestamp, values)) continue;
    addPendingActions(contactJid, msg, quickResponses, []);
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
      resource: config.resource || 'gtk-llm-chat',
    });

    xmppClient.reconnect.on('reconnecting', () => {
      xmppClient!.reconnect.delay = 5000;
    });

    // XEP-0115 caps
    const capsHash = '1a2b3c4d'; // simplified hash for the app
    const capsNode = 'https://github.com/icarito/gtk-llm-chat-android';

    xmppClient.on('online', () => {
      connectionState = 'online';
      notifyState();
      ForegroundService.start(config.jid).catch(() => {});

      // XEP-0280 Carbons
      xmppClient!.send(xml('iq', { type: 'set' }, xml('enable', { xmlns: 'urn:xmpp:carbons:2' }))).catch(() => {});
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
        const parsed = parseMamResult(mamResult, config.jid);
        if (parsed) buffer.push(parsed);
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
        timestamp: new Date().toISOString(),
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
      XmppHistory.recordMessage(
        platformId,
        msg.body,
        'in',
        msg.timestamp,
        null,
        quickResponses,
        commands,
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
    accountConfig = config;

    if (reconnectPromise) return reconnectPromise;
    if (connectionState === 'connecting') return;

    if (xmppClient && connectionState === 'online') {
      try {
        await pingServer(config.jid, 5000);
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
      await this.connect(config);
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
    removePendingAction(actionId);
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
  async syncHistory(contactJid: string): Promise<XmppMessage[]> {
    if (!xmppClient || connectionState !== 'online' || !accountConfig) return [];

    // Match GTK: re-fetch before our newest cached message with a generous
    // overlap so live-cache rows and action metadata get reconciled with MAM.
    const latest = await XmppHistory.getLatestTimestamp(contactJid);
    if (!latest) {
      const result = await runMamQuery(contactJid, { latest: true });
      return persistAndDedupe(contactJid, result.messages);
    }

    const start = new Date(new Date(latest).getTime() - OVERLAP_MS).toISOString();

    const collected: XmppMessage[] = [];
    let after: string | undefined;

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
