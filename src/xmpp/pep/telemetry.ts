import type { Element } from '@xmpp/xml';
import { NS_TELEMETRY, NS_TELEMETRY_LEGACY } from './namespaces';

export interface TelemetryContext {
  used?: number;
  max?: number;
  scope?: string;
  maxSource?: string;
}

export interface TelemetryTokens {
  total?: number;
  input?: number;
  output?: number;
  requests?: number;
  scope?: string;
}

export interface TelemetryCost {
  usd?: number;
  scope?: string;
}

/**
 * Payload de `urn:openclaw:telemetry:0` tal y como lo publica el gateway.
 * Los números ausentes se quedan `undefined`: "sin dato" no es cero.
 */
export interface AgentTelemetry {
  activity: string;
  availability: string;
  context: TelemetryContext;
  tokens: TelemetryTokens;
  cost: TelemetryCost;
  sessionCostUsd?: number;
  dayCostUsd?: number;
  model?: string;
  tool?: string;
  sessionStatus?: string;
}

function numberAttr(node: Element | undefined, attr: string): number | undefined {
  const raw = node?.attrs[attr];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function textAttr(node: Element | undefined, attr: string): string | undefined {
  const raw = node?.attrs[attr];
  return raw === undefined || raw === '' ? undefined : raw;
}

function textChild(node: Element | undefined, name: string): string | undefined {
  const text = node?.getChildText(name);
  return text === undefined || text === null || text === '' ? undefined : text;
}

function isTelemetryElement(el: Element): boolean {
  if (!el.is('telemetry')) return false;
  const xmlns = el.attrs.xmlns;
  return xmlns === undefined || xmlns === NS_TELEMETRY || xmlns === NS_TELEMETRY_LEGACY;
}

/**
 * Acepta tanto el `<telemetry/>` como el `<item>` PEP que lo contiene.
 * Devuelve `null` si el elemento no lleva telemetría OpenClaw.
 */
export function parseTelemetry(el: Element): AgentTelemetry | null {
  const telemetry = isTelemetryElement(el)
    ? el
    : el.getChild('telemetry', NS_TELEMETRY) ?? el.getChild('telemetry', NS_TELEMETRY_LEGACY);
  if (!telemetry) return null;

  const contextEl = telemetry.getChild('context');
  const tokensEl = telemetry.getChild('tokens');
  const costEl = telemetry.getChild('cost');
  const sessionEl = telemetry.getChild('session');

  return {
    activity: telemetry.attrs.activity ?? '',
    availability: telemetry.attrs.availability ?? '',
    context: {
      used: numberAttr(contextEl, 'used'),
      max: numberAttr(contextEl, 'max'),
      scope: textAttr(contextEl, 'scope'),
      maxSource: textAttr(contextEl, 'maxSource'),
    },
    tokens: {
      total: numberAttr(tokensEl, 'total'),
      input: numberAttr(tokensEl, 'input'),
      output: numberAttr(tokensEl, 'output'),
      requests: numberAttr(tokensEl, 'requests'),
      scope: textAttr(tokensEl, 'scope'),
    },
    cost: {
      usd: numberAttr(costEl, 'usd'),
      scope: textAttr(costEl, 'scope'),
    },
    sessionCostUsd: numberAttr(telemetry.getChild('session-cost'), 'usd'),
    dayCostUsd: numberAttr(telemetry.getChild('day-cost'), 'usd'),
    model: textChild(telemetry, 'model'),
    tool: textChild(telemetry, 'tool'),
    sessionStatus: textAttr(sessionEl, 'status'),
  };
}

/**
 * Coste honesto: sin tarifa conocida (o cero) no se inventa un importe.
 */
export function formatCost(usd?: number): string {
  if (usd === undefined || !Number.isFinite(usd) || usd === 0) return 'sin tarifa';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatTool(tool?: string): string {
  const text = (tool ?? '').trim();
  return text === '' ? 'ninguna' : text;
}
