import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';

export const NS_REPLY = 'urn:xmpp:reply:0';
export const NS_FALLBACK = 'urn:xmpp:fallback:0';

export type ReplyMessageType = 'chat' | 'groupchat';

export interface ReplyTarget {
  targetId: string;
  targetJid?: string;
  quotedText?: string;
}

export interface ParsedReply {
  targetId: string;
  targetJid?: string;
  bodyWithoutFallback: string;
}

function quotePrefix(quotedText: string): string {
  return (
    quotedText
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n') + '\n'
  );
}

function codepointLength(text: string): number {
  return Array.from(text).length;
}

export function buildReply(
  to: string,
  type: ReplyMessageType,
  body: string,
  target: ReplyTarget,
): Element {
  const prefix = target.quotedText ? quotePrefix(target.quotedText) : '';
  const fullBody = prefix + body;

  const replyAttrs: Record<string, string> = {
    xmlns: NS_REPLY,
    id: target.targetId,
  };
  if (target.targetJid) replyAttrs.to = target.targetJid;

  const children: Element[] = [
    xml('body', {}, fullBody),
    xml('reply', replyAttrs),
  ];

  if (target.quotedText) {
    // XEP-0428: los offsets son índices de CODEPOINTS (no unidades UTF-16) sobre
    // el texto del <body>. El rango cubre la cita completa, incluido su salto
    // de línea final.
    children.push(
      xml(
        'fallback',
        { xmlns: NS_FALLBACK, for: NS_REPLY },
        xml('body', {
          start: '0',
          end: String(codepointLength(prefix)),
        }),
      ),
    );
  }

  return xml('message', { to, type }, ...children);
}

export function parseReply(msg: Element): ParsedReply | null {
  const reply = msg.getChild('reply', NS_REPLY);
  if (!reply) return null;

  const rawBody = msg.getChildText('body') ?? '';
  const parsed: ParsedReply = {
    targetId: reply.attrs.id ?? '',
    bodyWithoutFallback: rawBody,
  };
  if (reply.attrs.to) parsed.targetJid = reply.attrs.to;

  const fallback = msg.getChild('fallback', NS_FALLBACK);
  if (fallback && fallback.attrs.for === NS_REPLY) {
    const range = fallback.getChild('body');
    if (range) {
      const start = Number.parseInt(range.attrs.start ?? '', 10);
      const end = Number.parseInt(range.attrs.end ?? '', 10);
      const codepoints = Array.from(rawBody);
      if (
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end >= start &&
        end <= codepoints.length
      ) {
        parsed.bodyWithoutFallback = codepoints
          .slice(0, start)
          .concat(codepoints.slice(end))
          .join('');
      }
    }
  }

  if (parsed.bodyWithoutFallback.startsWith('\n')) {
    parsed.bodyWithoutFallback = parsed.bodyWithoutFallback.slice(1);
  }

  return parsed;
}
