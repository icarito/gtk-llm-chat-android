import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import { buildFormElement } from './xep-0004';
import type { DataForm } from '@/types/xmpp';

const DISCO_ITEMS_NS = 'http://jabber.org/protocol/disco#items';
const COMMAND_NS = 'http://jabber.org/protocol/commands';

/** Build the first XEP-0050 request emitted by an inline approval button. */
export function buildCommandExecuteStanza(
  targetJid: string,
  node: string,
  id: string,
): Element {
  return xml(
    'iq',
    { type: 'set', to: targetJid, id },
    xml('command', { xmlns: COMMAND_NS, node, action: 'execute' }),
  );
}

export function buildQueryCommandStanza(
  title: string,
  question: string,
  options: Array<{ label: string; value: string }>,
  to: string,
  type: string,
  id: string,
  botFullJid: string,
  nodeForOption: (index: number, option: { label: string; value: string }) => string,
): Element {
  const lines = options.map((o, i) => `${i + 1}) ${o.label}`).join('\n');
  const bodyText = `${title}${question ? `\n\n${question}` : ''}\n\n${lines}`;

  const items = options.map((o, i) => {
    const shortName = o.label.length > 20 ? o.label.slice(0, 18) + '\u2026' : o.label;
    return xml('item', {
      jid: botFullJid,
      node: nodeForOption(i, o),
      name: shortName,
    });
  });

  const query = xml('query', { xmlns: DISCO_ITEMS_NS, node: COMMAND_NS }, ...items);

  return xml('message', { type, to, id }, xml('body', {}, bodyText), query);
}

export function buildCorrectionStanza(
  to: string,
  type: string,
  body: string,
  replaceId: string,
  newId?: string,
): Element {
  const id = newId ?? `nc-corr-${Date.now().toString(36)}`;
  return xml(
    'message',
    { type, to, id },
    xml('body', {}, body),
    xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: replaceId }),
  );
}

export function buildCardFormStanza(
  card: Record<string, unknown>,
  to: string,
  type: string,
  id: string,
): Element | null {
  const fields: Array<{
    var: string;
    type: 'fixed';
    value: string;
    label?: string;
  }> = [];

  let formTitle: string | undefined;
  const instructions: string[] = [];
  let fieldIdx = 0;

  if (typeof card.title === 'string' && card.title) {
    formTitle = card.title;
  }

  if (typeof card.description === 'string' && card.description) {
    instructions.push(card.description);
  }

  if (Array.isArray(card.children)) {
    for (const ch of card.children) {
      if (typeof ch === 'string' && ch) {
        fields.push({ var: `field${fieldIdx++}`, type: 'fixed', value: ch });
      } else if (ch && typeof ch === 'object' && typeof (ch as Record<string, unknown>).text === 'string') {
        const text = (ch as Record<string, string>).text;
        const label =
          typeof (ch as Record<string, unknown>).title === 'string' ? (ch as Record<string, string>).title : undefined;
        fields.push({ var: `field${fieldIdx++}`, type: 'fixed', value: text, label });
      }
    }
  }

  if (Array.isArray(card.actions)) {
    for (const a of card.actions as Array<Record<string, unknown>>) {
      if (typeof a.url === 'string' && a.url && typeof a.label === 'string') {
        fields.push({
          var: `field${fieldIdx++}`,
          type: 'fixed',
          label: a.label,
          value: a.url,
        });
      }
    }
  }

  if (fields.length === 0) return null;

  const form: DataForm = { type: 'form', title: formTitle, instructions, fields };
  const xElement = buildFormElement(form);

  return xml(
    'message',
    { type, to, id },
    xml('body', {}, formTitle || (card.description as string) || 'Card'),
    xElement,
  );
}

let stanzaSeq = 0;
export function nextStanzaId(): string {
  stanzaSeq += 1;
  return `nc-${Date.now().toString(36)}-${stanzaSeq.toString(36)}`;
}

export function resetStanzaSeq(): void {
  stanzaSeq = 0;
}

export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function markdownToPlain(md: string): string {
  return (
    md
      .replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => (code as string).replace(/\n$/, ''))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*]\s+/gm, '• ')
  );
}

export function extractApprovalSummary(body: string): string {
  const markdown = markdownToPlain(body);
  const parts: string[] = [];
  const warningMatch = markdown.match(/^\s*⚠️\s*(.+?)\s*$/m);
  if (warningMatch && warningMatch[1].trim()) {
    parts.push(`⚠️ ${warningMatch[1].trim()}`);
  }
  const lockMatch = markdown.match(/^\s*🔒\s*(.+?)\s*$/m);
  if (lockMatch && lockMatch[1].trim()) {
    parts.push(lockMatch[1].trim());
  }
  if (parts.length > 0) return parts.join('\n');
  const pendingMatch = markdown.match(/Pending command:\s*\n([\s\S]*)/i);
  if (pendingMatch && pendingMatch[1].trim()) {
    return pendingMatch[1].trim();
  }
  return markdown.trim();
}
