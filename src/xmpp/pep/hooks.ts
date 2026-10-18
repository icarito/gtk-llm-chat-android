import type { Element } from '@xmpp/xml';

export interface HookEvent {
  node: string;
  contractVersion?: number;
  event: string;
  state: string;
  sessionKey?: string;
  originJid?: string;
  target?: string;
  timestamp?: string;
}

export interface ActivityHook extends HookEvent {
  pendingCount?: number;
}

export interface ApprovalHook extends HookEvent {
  approvalId?: string;
  stanzaId?: string;
  jid?: string;
  expiresAtMs?: number;
  decision?: string;
  command?: string;
}

export interface ProgressHook extends HookEvent {
  detail?: string;
  state: 'start' | 'end';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Localiza el payload del hook: el propio elemento o el hijo con ese xmlns. */
function findPayload(el: Element, node: string): Element | null {
  if (el.attrs.xmlns === node) return el;
  for (const child of el.getChildElements()) {
    if (child.attrs.xmlns === node) return child;
  }
  return null;
}

function inferEvent(node: string): string {
  return node.split(':')[3] ?? '';
}

/**
 * Parsea un hook JSON de OpenClaw. Acepta el `<item>` PEP o ya el payload.
 * JSON inválido o un xmlns que no coincide con el nodo => `null`, nunca throw.
 */
export function parseHook(itemOrPayloadEl: Element, node: string): HookEvent | null {
  const payload = findPayload(itemOrPayloadEl, node);
  if (!payload) return null;

  let data: Record<string, unknown> | null;
  try {
    data = asRecord(JSON.parse(payload.text()));
  } catch {
    return null;
  }
  if (!data) return null;

  const event = stringField(data, 'event') ?? inferEvent(node);
  const state = stringField(data, 'state') ?? '';

  return {
    node,
    ...(numberField(data, 'contractVersion') !== undefined
      ? { contractVersion: numberField(data, 'contractVersion') }
      : {}),
    event,
    state,
    ...(stringField(data, 'sessionKey') !== undefined
      ? { sessionKey: stringField(data, 'sessionKey') }
      : {}),
    ...(stringField(data, 'originJid') !== undefined
      ? { originJid: stringField(data, 'originJid') }
      : {}),
    ...(stringField(data, 'target') !== undefined ? { target: stringField(data, 'target') } : {}),
    ...(stringField(data, 'timestamp') !== undefined
      ? { timestamp: stringField(data, 'timestamp') }
      : {}),
    ...(numberField(data, 'pendingCount') !== undefined
      ? { pendingCount: numberField(data, 'pendingCount') }
      : {}),
    ...(stringField(data, 'approvalId') !== undefined
      ? { approvalId: stringField(data, 'approvalId') }
      : {}),
    ...(stringField(data, 'stanzaId') !== undefined
      ? { stanzaId: stringField(data, 'stanzaId') }
      : {}),
    ...(stringField(data, 'jid') !== undefined ? { jid: stringField(data, 'jid') } : {}),
    ...(numberField(data, 'expiresAtMs') !== undefined
      ? { expiresAtMs: numberField(data, 'expiresAtMs') }
      : {}),
    ...(stringField(data, 'decision') !== undefined
      ? { decision: stringField(data, 'decision') }
      : {}),
    ...(stringField(data, 'command') !== undefined ? { command: stringField(data, 'command') } : {}),
    ...(stringField(data, 'detail') !== undefined ? { detail: stringField(data, 'detail') } : {}),
  };
}
