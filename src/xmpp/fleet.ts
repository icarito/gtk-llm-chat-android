/**
 * Fleet snapshot (proyección JoeWork, urn:joework:monitoring:2). Espejo de
 * xat (app/fleet_snapshot.gd + _request_fleet_monitoring en main.gd): NO es el
 * PEP del agente sino un nodo pubsub de un JID de monitoreo configurado
 * (jid + nodo), que se pide (items max 1) y al que nos suscribimos explícito.
 * Sin fuente configurada no se pide nada y nada se inventa.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { xml } from '@xmpp/client';
import { useSyncExternalStore } from 'react';
import type { Element } from '@xmpp/xml';
import { PUBSUB_NS } from '@/xmpp/ns';
import { NS_FLEET } from '@/xmpp/pep/namespaces';
import { bareJid } from '@/xmpp/parse';
import { session, usableClient } from '@/xmpp/session';

/** Métrica individual declarada bajo <metrics><metric …/>…</metrics>. */
export type FleetMetric = Record<string, string>;

/** Campos de <operational><field name=… value=…/>…</operational>. */
export type FleetOperational = Record<string, string>;

/** Una entidad (instancia) del snapshot, con sus métricas y estado operacional. */
export interface FleetEntity {
  jid?: string;
  'brain-url'?: string;
  id?: string;
  team?: string;
  label?: string;
  'entity-kind'?: string;
  lifecycle?: string;
  health?: string;
  state?: string;
  status?: string;
  metrics?: FleetMetric[];
  operational?: FleetOperational;
  [k: string]: unknown;
}

/** Fila de operación en curso (de <operational> no vacío). */
export interface FleetOperation {
  instance: string;
  'entity-kind'?: string;
  fields: FleetOperational;
}

/** Fila de costo (métrica cuyo nombre matchea cost/spend). */
export interface FleetCost extends FleetMetric {
  instance: string;
}

export interface FleetSnapshot {
  /** generated-at del <monitoring> ('' si no viene). */
  generatedAt?: string;
  /** true si stale o más viejo que STALE_AFTER_SECONDS. */
  stale: boolean;
  entities: FleetEntity[];
  operations: FleetOperation[];
  cost: FleetCost[];
}

const key = (k: string) => k.toLowerCase().replace(/_/g, '-');

/** Un snapshot de 900s se considera viejo (igual que xat). */
export const STALE_AFTER_SECONDS = 900;

const parseStale = (v: unknown): boolean =>
  typeof v === 'string' && ['true', '1', 'yes'].includes(v.trim().toLowerCase());

/** El proyector emite UTC en YYYY-MM-DDTHH:MM:SSZ (o epoch en seg/ms). */
function isStale(generatedAt: string): boolean {
  if (!generatedAt) return false;
  const nowSec = Date.now() / 1000;
  if (/^-?\d+$/.test(generatedAt)) {
    let stamp = Number(generatedAt);
    if (stamp > 100000000000) stamp = Math.floor(stamp / 1000);
    return nowSec - stamp > STALE_AFTER_SECONDS;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z?$/.exec(generatedAt);
  if (!m) return false;
  const stamp = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  return Number.isFinite(stamp) && stamp > 0 && nowSec - stamp > STALE_AFTER_SECONDS;
}

function parseInstance(inst: Element): FleetEntity {
  const entity: FleetEntity = {};
  for (const [k, v] of Object.entries(inst.attrs)) entity[key(k)] = String(v);
  const metrics: FleetMetric[] = [];
  const operational: FleetOperational = {};
  for (const child of inst.children) {
    if (typeof child === 'string') continue;
    const k = key(child.name);
    if (k === 'metrics') {
      for (const metric of child.getChildren('metric')) {
        const rec: FleetMetric = {};
        for (const [ak, av] of Object.entries(metric.attrs)) rec[key(ak)] = String(av);
        metrics.push(rec);
      }
    } else if (k === 'operational') {
      for (const field of child.getChildren('field')) {
        const name = String(field.attrs['name'] ?? 'field');
        operational[name] = String(field.attrs['value'] ?? field.text().trim());
      }
    } else if (!child.children.some((c) => typeof c !== 'string')) {
      entity[k] = child.text().trim();
    }
  }
  entity.metrics = metrics;
  entity.operational = operational;
  // La salud observada primero; estado declarado y lifecycle aparte, para que una
  // instancia hibernated nunca se lea como fallida (igual que xat).
  const lifecycle = String(entity.lifecycle ?? '').toLowerCase();
  if (lifecycle === 'hibernated') entity.status = 'hibernated';
  else if (typeof entity.health === 'string' && entity.health !== '') entity.status = entity.health;
  else if (typeof entity.state === 'string' && entity.state !== '') entity.status = entity.state;
  else if (typeof entity.lifecycle === 'string' && entity.lifecycle !== '') entity.status = entity.lifecycle;
  return entity;
}

/** <item><monitoring xmlns=NS_FLEET><instance …/>…</monitoring></item> (o el <monitoring/> directo) -> snapshot; vacío si no encaja. */
export function parseFleetSnapshot(el: Element | null | undefined): FleetSnapshot {
  const out: FleetSnapshot = { entities: [], stale: false, operations: [], cost: [] };
  const root = el?.is('item') ? el.children.find((c) => typeof c !== 'string') as Element | undefined : el;
  if (!root || root.name.toLowerCase() !== 'monitoring' || root.attrs.xmlns !== NS_FLEET) return out;
  out.generatedAt = String(root.attrs['generated-at'] ?? '');
  const declared = parseStale(root.attrs['stale']);
  out.stale = declared || isStale(out.generatedAt);
  for (const inst of root.getChildren('instance')) {
    const entity = parseInstance(inst);
    out.entities.push(entity);
    if (entity.operational && Object.keys(entity.operational).length > 0) {
      out.operations.push({
        instance: String(entity.team ?? entity.id ?? ''),
        'entity-kind': String(entity['entity-kind'] ?? ''),
        fields: entity.operational,
      });
    }
    for (const metric of entity.metrics ?? []) {
      const name = String(metric.name ?? metric.metric ?? '').toLowerCase();
      if (name.includes('cost') || name.includes('spend')) {
        out.cost.push({ ...metric, instance: String(entity.team ?? entity.id ?? '') });
      }
    }
  }
  return out;
}

/** Sólo https: nunca rutas locales ni otros esquemas. */
export const safeUrl = (url: unknown): string => {
  const u = typeof url === 'string' ? url : '';
  return u.startsWith('https://') ? u : '';
};

/** brain-url (https) declarado para la entidad con ese JID; '' si no hay. */
export function brainUrl(snapshot: FleetSnapshot, jid: string): string {
  const want = jid.toLowerCase();
  if (!want) return '';
  const entity = snapshot.entities.find((e) => (e.jid ?? '').toLowerCase() === want);
  return safeUrl(entity?.['brain-url'] ?? '');
}

let source: { jid: string; node: string } | null = null;
let snapshot: FleetSnapshot = { entities: [], stale: false, operations: [], cost: [] };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const getSnapshot = (): FleetSnapshot => snapshot;

/** Snapshot actual (sin suscripción). */
export const currentFleetSnapshot = (): FleetSnapshot => snapshot;

/** Si hay una fuente de monitoreo configurada. */
export const hasFleetSource = (): boolean => source !== null;

/** Fija el JID de monitoreo y su nodo (en xat: ajustes fleet_monitor_jid / fleet_monitor_node). */
export function setFleetSource(jid: string, node: string = NS_FLEET) {
  source = jid && node ? { jid: bareJid(jid).toLowerCase(), node } : null;
  snapshot = { entities: [], stale: false, operations: [], cost: [] };
  emit();
}

/** Evento PEP/pubsub entrante; true si era del nodo de flota (consumido). */
export function handleFleetEvent(from: string | undefined, node: string | undefined, items: Element[]): boolean {
  if (!source || node !== source.node || !from || bareJid(from).toLowerCase() !== source.jid) return false;
  const last = items[items.length - 1];
  if (last) { snapshot = parseFleetSnapshot(last); emit(); }
  return true;
}

const SOURCE_KEY = 'fleet.source';
let loaded = false;

/** Fuente guardada en ajustes ({jid,node}) o null. */
export async function getStoredFleetSource(): Promise<{ jid: string; node: string } | null> {
  try {
    const raw = await AsyncStorage.getItem(SOURCE_KEY);
    const v = raw ? (JSON.parse(raw) as { jid?: unknown; node?: unknown }) : null;
    return v && typeof v.jid === 'string' && typeof v.node === 'string' ? { jid: v.jid, node: v.node } : null;
  } catch {
    return null;
  }
}

/** Guarda la fuente (vacía la borra), la aplica y pide el snapshot. */
export async function saveFleetSource(jid: string, node: string): Promise<void> {
  loaded = true;
  if (jid && node) await AsyncStorage.setItem(SOURCE_KEY, JSON.stringify({ jid: bareJid(jid).toLowerCase(), node }));
  else await AsyncStorage.removeItem(SOURCE_KEY);
  setFleetSource(jid, node);
  await fetchFleet();
}

/** Pide el último valor y se suscribe (xat: request_pubsub_items + subscribe_pubsub). */
export async function fetchFleet(): Promise<void> {
  if (!loaded) {
    loaded = true;
    const stored = await getStoredFleetSource();
    if (stored) setFleetSource(stored.jid, stored.node);
  }
  const client = usableClient();
  if (!client || !source) return;
  const { jid, node } = source;
  try {
    const result = await client.iqCaller.request(
      xml('iq', { type: 'get', to: jid },
        xml('pubsub', { xmlns: PUBSUB_NS }, xml('items', { node, max_items: '1' }))),
      10000,
    );
    const items = result.getChild('pubsub', PUBSUB_NS)?.getChild('items')?.getChildren('item') ?? [];
    handleFleetEvent(jid, node, items);
    const me = session.account ? bareJid(session.account.jid) : '';
    if (me) {
      await client.iqCaller.request(
        xml('iq', { type: 'set', to: jid },
          xml('pubsub', { xmlns: PUBSUB_NS }, xml('subscribe', { node, jid: me }))),
        10000,
      );
    }
  } catch {
    // Sin permiso o sin nodo: el botón simplemente no aparece.
  }
}

/** brain-url del chat `jid` (primitivo: re-renderiza sólo si cambia). null en salas / sin declaración. */
export function useBrainUrl(jid: string): string | null {
  return useSyncExternalStore(subscribe, () => brainUrl(snapshot, jid) || null);
}

/** Snapshot completo, suscrito al store de flota (para el monitor). */
export function useFleetSnapshot(): FleetSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}
