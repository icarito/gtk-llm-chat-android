import type { FleetEntity, FleetSnapshot } from '@/xmpp/fleet';

/** Estados agregados del inventario (espejo de xat). */
export type FleetState = 'ready' | 'degraded' | 'down' | 'unknown' | 'hibernated';

export const STATE_ORDER: FleetState[] = ['ready', 'degraded', 'down', 'unknown', 'hibernated'];

export const STATE_LABEL: Record<FleetState, string> = {
  ready: 'READY',
  degraded: 'DEGRADED',
  down: 'DOWN',
  unknown: 'UNKNOWN',
  hibernated: 'HIBERNATED',
};

export const STATE_COLOR: Record<FleetState, string> = {
  ready: '#4ADE80',
  degraded: '#FFB547',
  down: '#FF5C7A',
  unknown: '#8B93A7',
  hibernated: '#7E91B5',
};

export const STATE_TINT: Record<FleetState, string> = {
  ready: '#183023',
  degraded: '#352A1B',
  down: '#351D26',
  unknown: '#222833',
  hibernated: '#202A3C',
};

const HEALTH_READY = ['ready', 'healthy', 'up', 'running', 'online', 'active', 'ok'];
const HEALTH_DEGRADED = ['degraded', 'unhealthy'];
const HEALTH_DOWN = ['down', 'failed', 'error'];

/** Estado agregado de la entidad (lifecycle hibernated tiene prioridad). */
export function stateKey(entity: FleetEntity): FleetState {
  const lifecycle = String(entity.lifecycle ?? '').toLowerCase();
  const health = String(entity.health ?? entity.status ?? '').toLowerCase();
  if (lifecycle === 'hibernated' || health === 'hibernated') return 'hibernated';
  if (HEALTH_READY.includes(health)) return 'ready';
  if (HEALTH_DEGRADED.includes(health)) return 'degraded';
  if (HEALTH_DOWN.includes(health)) return 'down';
  return 'unknown';
}

export const stateTitle = (s: FleetState): string => STATE_LABEL[s];

export const stateColor = (s: FleetState): string => STATE_COLOR[s];

export const stateTint = (s: FleetState): string => STATE_TINT[s];

/** Tipo de entidad: métrica con nombre type/spend si existe; si no, entity-kind. */
export function entityType(entity: FleetEntity): string {
  for (const m of entity.metrics ?? []) {
    const name = String(m.name ?? '').toLowerCase();
    if (name.includes('type')) {
      const v = String(m.value ?? '').trim();
      if (v) return v;
    }
  }
  const kind = String(entity['entity-kind'] ?? '').trim();
  return kind || 'entity';
}

/** Etiqueta de frescura del snapshot (WAITING/UNKNOWN/LIVE/STALE). */
export function freshnessState(snapshot: FleetSnapshot): 'waiting' | 'unknown' | 'live' | 'stale' {
  if (snapshot.stale) return 'stale';
  if (snapshot.generatedAt) return 'live';
  if (snapshot.entities.length > 0) return 'unknown';
  return 'waiting';
}

export const FRESHNESS_LABEL: Record<'waiting' | 'unknown' | 'live' | 'stale', string> = {
  waiting: 'WAITING',
  unknown: 'UNKNOWN',
  live: 'LIVE',
  stale: 'STALE',
};

/** Conteos por estado a partir del inventario. */
export function countStates(entities: FleetEntity[]): Record<FleetState, number> {
  const counts: Record<FleetState, number> = { ready: 0, degraded: 0, down: 0, unknown: 0, hibernated: 0 };
  for (const e of entities) counts[stateKey(e)] += 1;
  return counts;
}

/** "e1, e2, e3" para un jid largo. */
export function ellipsize(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
