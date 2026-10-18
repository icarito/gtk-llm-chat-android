/** XEP-0313 (MAM): consulta del archivo, caché local y reconciliación de historial. */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import type { XmppMessage } from '@/types/xmpp';
import { isEncrypted } from '@/xmpp/encryption';
import { XmppHistory, type HistoryRow } from '@/xmpp/XmppHistory';
import { decryptStanzaIfEncrypted } from '@/xmpp/decrypt';
import { isGroupConversation } from '@/xmpp/muc';
import { QUICK_RESPONSE_NS } from '@/xmpp/ns';
import {
  bareJid,
  bodyWithOob,
  extractReply,
  extractOobUrl,
  extractStanzaId,
  parseActionMetadata,
  parseReplaceId,
  replyBody,
} from '@/xmpp/parse';
import { restorePendingQuickResponses } from '@/xmpp/actions';
import { applyReactions, applyRetraction, patchList } from '@/xmpp/annotations';
import { historyExtra } from '@/xmpp/messages';
import { rooms } from '@/xmpp/store';
import { foldReactions, parseReactions } from '@/xmpp/xep/reactions';
import { parseRetract } from '@/xmpp/xep/retract';
import { session, usableClient } from '@/xmpp/session';
import type { StanzaCtx } from '@/xmpp/session';

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

  const body = bodyWithOob(message, replyBody(message) ?? message.getChildText('body') ?? '');
  const reactions = parseReactions(message);
  const retractId = parseRetract(message);
  // Reacciones y retractaciones archivadas son eventos, no burbujas.
  if (!body && !reactions) return null;

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

  const actions = parseActionMetadata(message);
  const senderNick = type === 'groupchat' ? fromAttr.split('/')[1] : undefined;
  // En una sala el id de archivo ES el stanza-id; <stanza-id> lo confirma si viene.
  const stanzaId = type === 'groupchat' ? extractStanzaId(message, fromBare) ?? (mamId || null) : null;

  return {
    id: (message.attrs.id as string) || mamId || `mam-${timestamp}`,
    stanzaId,
    senderNick,
    retractId,
    reactionEvent: reactions
      ? { targetId: reactions.targetId, emojis: reactions.emojis, sender: type === 'groupchat' ? fromAttr : fromBare }
      : null,
    mamId: mamId || null,
    from: fromBare,
    to: toBare,
    type,
    body,
    timestamp,
    direction,
    isGroup: type === 'groupchat',
    quickResponses: actions.quickResponses,
    commands: actions.commands,
    replyTo: extractReply(message),
    oobUrl: extractOobUrl(message, body),
    replaceId: parseReplaceId(message),
  };
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
  const client = session.client;
  if (!client || !session.account) return { messages: [], complete: true, last: null };

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
    const reply = await client.iqCaller.request(
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
export async function persistAndDedupe(contactJid: string, messages: XmppMessage[]): Promise<XmppMessage[]> {
  const fresh: XmppMessage[] = [];
  for (const msg of messages) {
    const mamId = msg.mamId ?? null;
    // Every message id is a possible XEP-0308 target. Streaming seeds usually
    // have no buttons, so persisting ids only for actionable messages made
    // their final corrections update memory but miss SQLite entirely.
    const stanzaId = msg.id;

    if (msg.reactionEvent) {
      const { targetId, emojis, sender } = msg.reactionEvent;
      applyReactions(contactJid, targetId, sender, emojis);
      patchList(fresh, targetId, (m) => ({ ...m, reactions: foldReactions(m.reactions, sender, emojis) }));
      continue;
    }
    if (msg.retractId) {
      const author = msg.type === 'groupchat' ? { nick: msg.senderNick } : { direction: msg.direction };
      applyRetraction(contactJid, msg.retractId, author);
      patchList(fresh, msg.retractId, (m) =>
        (author.nick ? m.senderNick === author.nick : m.direction === author.direction) ? { ...m, retracted: true } : null);
      continue;
    }
    if (msg.replaceId) {
      const applied = await XmppHistory.applyCorrectionByStanzaId(
        contactJid,
        msg.replaceId,
        msg.body,
        msg.timestamp,
        isEncrypted(msg.encryptionStatus),
      );
      if (applied) {
        const pending = fresh.findIndex((candidate) => candidate.id === msg.replaceId);
        if (pending >= 0) {
          fresh[pending] = {
            ...fresh[pending],
            body: msg.body,
            timestamp: msg.timestamp,
            wasEncrypted: isEncrypted(msg.encryptionStatus) || fresh[pending].wasEncrypted,
            encryptionStatus: msg.encryptionStatus ?? fresh[pending].encryptionStatus,
          };
        }
      }
      // A correction is never a standalone chat bubble. If its target is
      // outside this archive page it will be folded when that page is loaded.
      continue;
    }
    if (mamId && await XmppHistory.attachMamToRecentMessage(
      contactJid,
      msg.body,
      msg.direction,
      msg.timestamp,
      mamId,
      msg.quickResponses ?? null,
      msg.commands ?? null,
      stanzaId,
      isEncrypted(msg.encryptionStatus),
    )) {
      continue;
    }
    const extra = historyExtra(msg);
    const inserted = await XmppHistory.recordMessage(
      contactJid,
      msg.body,
      msg.direction,
      msg.timestamp,
      mamId,
      msg.quickResponses ?? null,
      msg.commands ?? null,
      stanzaId,
      null,
      null,
      null,
      null,
      null,
      isEncrypted(msg.encryptionStatus),
      ...(extra ? [extra] as [typeof extra] : []),
    );
    if (inserted) fresh.push(msg);
  }
  fresh.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return fresh;
}

/** Rehydrate a cached row into the shape the UI renders. */
export function rowToMessage(row: HistoryRow, contactJid: string): XmppMessage {
  const ownJid = session.account?.jid ?? '';
  const group = rooms.get(contactJid) !== undefined;
  return {
    id: row.stanza_id || row.mam_id || `cache-${row.direction}-${row.timestamp}`,
    mamId: row.mam_id,
    from: row.direction === 'out' ? ownJid : contactJid,
    to: row.direction === 'out' ? contactJid : ownJid,
    type: group ? 'groupchat' : 'chat',
    body: row.body,
    timestamp: row.timestamp,
    direction: row.direction,
    wasEncrypted: row.was_encrypted === 1,
    encryptionStatus: row.was_encrypted === 1 ? 'encrypted' : undefined,
    isGroup: group,
    stanzaId: row.muc_stanza_id ?? (group ? row.mam_id : null),
    senderNick: row.sender_nick ?? undefined,
    reactions: row.reactions ?? undefined,
    replyTo: row.reply_to,
    retracted: row.retracted === 1 ? true : undefined,
    quickResponses: row.quick_responses,
    commands: row.commands,
    oobUrl: row.oob_url,
    attachmentDuration: row.attachment_duration,
    attachmentMimeType: row.attachment_mime_type,
  };
}

/**
 * XEP-0313: archived message delivered for an in-flight query.
 * These arrive as type-less <message> wrappers with no <body> of their
 * own, so they must be handled before the chat/groupchat filter.
 * Usar sólo si `isMamResult(stanza)`.
 */
export function isMamResult(stanza: Element): boolean {
  return Boolean(stanza.getChild('result', 'urn:xmpp:mam:2'));
}

export async function handleMamResult(stanza: Element, ctx: StanzaCtx): Promise<void> {
  const { config, botNick } = ctx;
  const mamResult = stanza.getChild('result', 'urn:xmpp:mam:2');
  if (!mamResult) return;
  const queryid = (mamResult.attrs.queryid as string) || '';
  const buffer = pendingMamQueries.get(queryid);
  if (!buffer) return;

  let mamEncryptionStatus: XmppMessage['encryptionStatus'];
  const forwarded = mamResult.getChild('forwarded', 'urn:xmpp:forward:0');
  const message = forwarded?.getChild('message');
  if (message) {
    const fromAttr = (message.attrs.from as string) || '';
    const fromBare = bareJid(fromAttr);
    const ownBare = bareJid(config.jid);
    const direction = fromBare === ownBare ? 'out' : 'in';
    const senderJid = direction === 'out' ? ownBare : fromBare;

    const { decryptedBody, wasEncrypted, decryptedMetadata, encryptionStatus } = await decryptStanzaIfEncrypted(message, senderJid, false);
    mamEncryptionStatus = encryptionStatus;
    if (wasEncrypted && decryptedBody) {
      const encryptedNode = message.getChild('encrypted', 'eu.siacs.conversations.axolotl')
        || message.getChild('encrypted', 'urn:xmpp:omemo:2');
      if (encryptedNode) {
        const idx = message.children.indexOf(encryptedNode);
        if (idx !== -1) message.children.splice(idx, 1);
      }
      // Fuera el <body> de respaldo en claro (OMEMO 2 lo trae): getChildText tomaría el primero.
      message.children = message.children.filter((c) => c.name !== 'body');
      message.children.push(xml('body', {}, decryptedBody));

      if (decryptedMetadata) {
        if (decryptedMetadata.quickResponses) {
          for (const qr of decryptedMetadata.quickResponses) {
            message.children.push(xml('response', {
              xmlns: QUICK_RESPONSE_NS,
              label: qr.label,
              value: qr.value,
              ...(qr.style ? { style: qr.style } : {}),
              ...(qr.expiresAtMs ? { 'expires-at-ms': String(qr.expiresAtMs) } : {}),
            }));
          }
        }
        if (decryptedMetadata.commands) {
          for (const cmd of decryptedMetadata.commands) {
            message.children.push(xml('command-item', {
              xmlns: 'urn:xmpp:oc:approval:0',
              jid: cmd.jid,
              node: cmd.node,
              name: cmd.name,
              ...(cmd.style ? { style: cmd.style } : {}),
              ...(cmd.expiresAtMs ? { 'expires-at-ms': String(cmd.expiresAtMs) } : {}),
            }));
          }
        }
      }
    }
  }

  const roomJid = bareJid((message?.attrs.from as string) || '');
  const parsed = parseMamResult(mamResult, config.jid, rooms.get(roomJid)?.nick || botNick);
  if (parsed) {
    parsed.encryptionStatus = mamEncryptionStatus;
    parsed.wasEncrypted = isEncrypted(mamEncryptionStatus);
    buffer.push(parsed);
  }
  return;
}

/**
 * Messages already cached locally — render these immediately, before any
 * network round-trip.
 */
export async function loadCachedHistory(
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
}

export async function restoreCachedActions(contactJid: string, limit = 50): Promise<void> {
  const rows = await XmppHistory.getRecent(contactJid, limit);
  await restorePendingQuickResponses(contactJid, rows.map((row) => rowToMessage(row, contactJid)));
}

/**
 * One cached preview per roster item, used by the conversation list before
 * the user opens a chat or MAM catch-up has completed.
 */
export async function loadCachedPreviews(contactJids: string[]): Promise<Map<string, XmppMessage>> {
  const rows = await XmppHistory.getLatestForContacts(contactJids);
  const previews = new Map<string, XmppMessage>();
  for (const row of rows) {
    const current = previews.get(row.bare_jid);
    if (!current || new Date(row.timestamp).getTime() >= new Date(current.timestamp).getTime()) {
      previews.set(row.bare_jid, rowToMessage(row, row.bare_jid));
    }
  }
  return previews;
}

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
export async function syncHistory(contactJid: string, force = false): Promise<XmppMessage[]> {
  if (!usableClient() || !session.account) return [];

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
}

/**
 * The page of messages older than `beforeTimestamp` — for scroll-to-load.
 * Serves from cache when possible, otherwise reaches into the archive with
 * an `end=` filter.
 */
export async function loadOlderHistory(contactJid: string, beforeTimestamp: string, limit = 50): Promise<XmppMessage[]> {
  const cached = await XmppHistory.getBefore(contactJid, beforeTimestamp, limit);
  if (cached.length > 0) {
    return cached.map((row) => rowToMessage(row, contactJid));
  }
  if (!usableClient() || !session.account) return [];

  const result = await runMamQuery(contactJid, { end: beforeTimestamp });
  return persistAndDedupe(contactJid, result.messages);
}
