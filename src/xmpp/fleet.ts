/**
 * Fleet snapshot (proyección JoeWork, urn:joework:monitoring:2). Espejo de
 * xat (app/fleet_snapshot.gd + _request_fleet_monitoring en main.gd): NO es el
 * PEP del agente sino un nodo pubsub de un JID de monitoreo configurado
 * (jid + nodo), que se pide (items max 1) y al que nos suscribimos explícito.
 * Sin fuente configurada no se pide nada y nada se inventa.
 */
import { xml } from '@xmpp/client';
import { useSyncExternalStore } from 'react';
import type { Element } from '@xmpp/xml';
import { PUBSUB_NS } from '@/xmpp/ns';
import { NS_FLEET } from '@/xmpp/pep/namespaces';
import { bareJid } from '@/xmpp/parse';
import { session, usableClient } from '@/xmpp/session';

export type FleetEntity = Record<string, string>;
export interface FleetSnapshot { entities: FleetEntity[] }

const key = (k: string) => k.toLowerCase().replace(/_/g, '-');

/** <item><monitoring xmlns=NS_FLEET><instance …/>…</monitoring></item> (o el <monitoring/> directo) -> snapshot; vacío si no encaja. */
export function parseFleetSnapshot(el: Element | null | undefined): FleetSnapshot {
  const out: FleetSnapshot = { entities: [] };
  const root = el?.is('item') ? el.children.find((c) => typeof c !== 'string') as Element | undefined : el;
  if (!root || root.name.toLowerCase() !== 'monitoring' || root.attrs.xmlns !== NS_FLEET) return out;
  for (const inst of root.getChildren('instance')) {
    const entity: FleetEntity = {};
    for (const [k, v] of Object.entries(inst.attrs)) entity[key(k)] = String(v);
    // Hijos de sólo texto (<jid>, <brain-url>…); los anidados (metrics, operational) no hacen falta aquí.
    for (const child of inst.children) {
      if (typeof child === 'string' || child.children.some((c) => typeof c !== 'string')) continue;
      entity[key(child.name)] = child.text().trim();
    }
    out.entities.push(entity);
  }
  return out;
}

/** Sólo https: nunca rutas locales ni otros esquemas. */
export const safeUrl = (url: string): string => (url.startsWith('https://') ? url : '');

/** brain-url (https) declarado para la entidad con ese JID; '' si no hay. */
export function brainUrl(snapshot: FleetSnapshot, jid: string): string {
  const want = jid.toLowerCase();
  if (!want) return '';
  const entity = snapshot.entities.find((e) => (e.jid ?? '').toLowerCase() === want);
  return safeUrl(entity?.['brain-url'] ?? '');
}

let source: { jid: string; node: string } | null = null;
let snapshot: FleetSnapshot = { entities: [] };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** Fija el JID de monitoreo y su nodo (en xat: ajustes fleet_monitor_jid / fleet_monitor_node). */
export function setFleetSource(jid: string, node: string = NS_FLEET) {
  source = jid && node ? { jid: bareJid(jid).toLowerCase(), node } : null;
  snapshot = { entities: [] };
  emit();
}

/** Evento PEP/pubsub entrante; true si era del nodo de flota (consumido). */
export function handleFleetEvent(from: string | undefined, node: string | undefined, items: Element[]): boolean {
  if (!source || node !== source.node || !from || bareJid(from).toLowerCase() !== source.jid) return false;
  const last = items[items.length - 1];
  if (last) { snapshot = parseFleetSnapshot(last); emit(); }
  return true;
}

/** Pide el último valor y se suscribe (xat: request_pubsub_items + subscribe_pubsub). */
export async function fetchFleet(): Promise<void> {
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
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => brainUrl(snapshot, jid) || null,
  );
}
