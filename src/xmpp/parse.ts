/** Helpers puros de parseo de stanzas, compartidos por los módulos de src/xmpp. */
import type { Element } from '@xmpp/xml';
import type { XmppButtonStyle, XmppInlineCommand, XmppMessage, XmppQuickResponse } from '@/types/xmpp';
import { parseReply } from '@/xmpp/xep/reply';
import {
  COMMAND_NS,
  DISCO_ITEMS_NS,
  LEGACY_QUICK_RESPONSE_NS,
  MESSAGE_CORRECT_NS,
  QUICK_RESPONSE_NS,
} from '@/xmpp/ns';

export function bareJid(full: string): string {
  return full.split('/')[0] ?? full;
}

export function parseCaps(stanza: Element): string | null {
  const c = stanza.getChild('c', 'http://jabber.org/protocol/caps');
  if (!c) return null;
  return (c.attrs.node as string) || null;
}

/**
 * XEP-0461 en una stanza entrante. `text` es la cita que el emisor puso en el
 * fallback XEP-0428 (sin los `> `); `id` es el mensaje citado.
 */
export function extractReply(stanza: Element): NonNullable<XmppMessage['replyTo']> | null {
  const parsed = parseReply(stanza);
  if (!parsed) return null;
  const raw = stanza.getChildText('body') ?? '';
  const stripped = parsed.bodyWithoutFallback;
  let text = '';
  if (stripped !== raw && raw.endsWith(stripped)) {
    text = raw.slice(0, raw.length - stripped.length).replace(/\n$/, '')
      .split('\n').map((line) => line.replace(/^> ?/, '')).join('\n');
  }
  return {
    text,
    sender: parsed.targetJid ? bareJid(parsed.targetJid) : 'unknown',
    id: parsed.targetId,
    ...(parsed.targetJid ? { jid: parsed.targetJid } : {}),
  };
}

/** Cuerpo sin el fallback de la respuesta (null si la stanza no es una respuesta). */
export function replyBody(stanza: Element): string | null {
  return parseReply(stanza)?.bodyWithoutFallback ?? null;
}

/** XEP-0359: el stanza-id que asignó `by` (la sala, en groupchat). */
export function extractStanzaId(stanza: Element, by: string): string | null {
  const found = stanza.getChildren('stanza-id', 'urn:xmpp:sid:0')
    .find((el) => el.attrs.by === by);
  return (found?.attrs.id as string | undefined) || null;
}

/**
 * XEP-0203 delayed-delivery stamp, if present. A message replayed by the server
 * (offline queue) or by a room on join carries the original send time here;
 * without it we would stamp it "now" and it would sort to the bottom of the
 * conversation and fall outside the ±30s window the MAM reconciler uses.
 */
export function extractDelayStamp(stanza: Element): string | null {
  const delay = stanza.getChild('delay', 'urn:xmpp:delay');
  const stamp = delay?.attrs.stamp as string | undefined;
  if (!stamp) return null;
  const t = new Date(stamp).getTime();
  return Number.isNaN(t) ? null : stamp;
}

export function extractOobUrl(stanza: Element, body: string): string | null {
  const x = stanza.getChild('x', 'jabber:x:oob');
  const url = x?.getChildText('url');
  if (url) return url.trim();
  const trimmed = body.trim();
  if (/^https?:\/\/\S+$/.test(trimmed)) return trimmed;
  return null;
}

export function bodyWithOob(stanza: Element, body: string): string {
  const text = body.trim();
  const oobUrl = extractOobUrl(stanza, text);
  if (!oobUrl) return text;
  if (!text) return oobUrl;
  if (text.includes(oobUrl)) return text;
  return `${text}\n${oobUrl}`;
}

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
  const replace = stanza.getChild('replace', MESSAGE_CORRECT_NS)
    ?? stanza.getChildren('replace').find((candidate) => {
      const namespace = candidate.attrs.xmlns;
      return namespace === MESSAGE_CORRECT_NS;
    });
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
      const expiresAtMs = parseExpiresAtMs(item.attrs['expires-at-ms']);
      if (jid && node && name) {
        commands.push({
          jid,
          node,
          name,
          ...(style ? { style } : {}),
          ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
        });
      }
    }
  }
  return commands;
}

export function parseActionMetadata(stanza: Element): {
  quickResponses: XmppQuickResponse[];
  commands: XmppInlineCommand[];
} {
  const commands = parseInlineCommands(stanza);
  return {
    commands,
    quickResponses: commands.length > 0 ? [] : parseQuickResponses(stanza),
  };
}
