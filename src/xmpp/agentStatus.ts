export interface AgentStatusInfo {
  activity: string;
  tool?: string;
  request?: string;
  tokens?: string;
  inputTokens?: string;
  outputTokens?: string;
  cost?: string;
  model?: string;
  bypass?: string;
  notes: string[];
}

type AgentStatusMetricKey = Exclude<keyof AgentStatusInfo, 'notes'>;

const KEY_ALIASES: Record<string, AgentStatusMetricKey> = {
  req: 'request',
  request: 'request',
  requests: 'request',
  request_count: 'request',
  tok: 'tokens',
  tokens: 'tokens',
  total_tokens: 'tokens',
  tokens_total: 'tokens',
  in: 'inputTokens',
  input: 'inputTokens',
  input_tokens: 'inputTokens',
  prompt_tokens: 'inputTokens',
  tokens_in: 'inputTokens',
  out: 'outputTokens',
  output: 'outputTokens',
  output_tokens: 'outputTokens',
  completion_tokens: 'outputTokens',
  tokens_out: 'outputTokens',
  cost: 'cost',
  usd: 'cost',
  cost_usd: 'cost',
  model: 'model',
  model_id: 'model',
  tool: 'tool',
  current_tool: 'tool',
  bypass: 'bypass',
  approval_bypass: 'bypass',
};

export function parseAgentStatus(status?: string | null): AgentStatusInfo {
  const text = (status ?? '').trim();
  const parsed: AgentStatusInfo = { activity: text, notes: [] };
  if (!text) return parsed;

  const jsonText = text.startsWith('nanoclaw:') ? text.slice('nanoclaw:'.length).trim() : text;
  if (jsonText.startsWith('{')) {
    try {
      const data = JSON.parse(jsonText) as Record<string, unknown>;
      return normalizeStatusRecord(data, text);
    } catch {
      // Human-readable presence status is still valid.
    }
  }

  const parts = text.split(/\s*\|\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 0) parsed.activity = parts[0]!;
  for (const part of parts.slice(1)) {
    const match = part.match(/^([A-Za-z _-]+)\s*[:=]\s*(.+)$/);
    if (!match) {
      parsed.notes.push(part);
      continue;
    }
    const target = KEY_ALIASES[normalizeKey(match[1]!)] ?? normalizeKey(match[1]!);
    if (isAgentStatusKey(target)) {
      parsed[target] = match[2]!.trim();
    } else {
      parsed.notes.push(part);
    }
  }
  return parsed;
}

export function formatAgentActivity(activity: string): string {
  const text = activity.trim();
  const lower = text.toLowerCase();
  if (lower === 'processing') return 'Trabajando';
  if (lower === 'available') return 'Disponible';
  if (lower === 'waiting') return 'En espera';
  if (lower.startsWith('tool:')) return `Herramienta: ${text.split(':').slice(1).join(':').trim()}`;
  return text || 'Sin estado';
}

export function formatAgentDetails(status: AgentStatusInfo): string[] {
  const details: string[] = [];
  if (status.tool) details.push(`Tool: ${status.tool}`);

  const tokenParts: string[] = [];
  if (status.tokens) tokenParts.push(`tok ${formatCount(status.tokens)}`);
  if (status.inputTokens) tokenParts.push(`in ${formatCount(status.inputTokens)}`);
  if (status.outputTokens) tokenParts.push(`out ${formatCount(status.outputTokens)}`);
  if (tokenParts.length > 0) details.push(tokenParts.join(' '));

  if (status.request) details.push(`Req: ${status.request}`);
  if (status.cost) details.push(`Cost: ${formatCost(status.cost)}`);
  if (status.model) details.push(status.model);
  details.push(...status.notes.slice(0, 2));
  return details;
}

function normalizeStatusRecord(data: Record<string, unknown>, fallback: string): AgentStatusInfo {
  const parsed: AgentStatusInfo = {
    activity: stringValue(data.activity ?? data.state) || fallback,
    notes: [],
  };
  for (const [rawKey, rawValue] of Object.entries(data)) {
    const target = KEY_ALIASES[normalizeKey(rawKey)] ?? normalizeKey(rawKey);
    if (!isAgentStatusKey(target)) continue;
    const value = stringValue(rawValue);
    if (value) parsed[target] = value;
  }
  return parsed;
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isAgentStatusKey(key: string): key is AgentStatusMetricKey {
  return [
    'activity',
    'tool',
    'request',
    'tokens',
    'inputTokens',
    'outputTokens',
    'cost',
    'model',
    'bypass',
  ].includes(key);
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function formatCount(value: string): string {
  const number = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(number)) return value;
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return String(Math.trunc(number));
}

function formatCost(value: string): string {
  const number = Number(value.replace(/[$,]/g, ''));
  if (!Number.isFinite(number)) return value;
  return number < 1 ? `$${number.toFixed(4)}` : `$${number.toFixed(2)}`;
}
