/**
 * XEP-0115 caps / disco#info de un contacto: ¿es un agente OpenClaw?
 *
 * Store observable (get/subscribe + hook) alimentado por un iq get de
 * disco#info al JID del contacto. Se cachea por JID bare. Un contacto es
 * agente si anuncia las features de telemetría (`+notify`) Y COMMANDS
 * (XEP-0050) — mismo criterio que features_mark_agent del gateway.
 */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { COMMAND_NS, DISCO_INFO_NS } from '@/xmpp/ns';
import { usableClient } from '@/xmpp/session';

export const OPENCLAW_NODE = 'https://github.com/openclaw/openclaw';

/** Telemetría OpenClaw actual + legacy NanoClaw, siempre con +notify. */
export const AGENT_TELEMETRY_NOTIFY = [
  'urn:openclaw:telemetry:0+notify',
  'urn:nanoclaw:telemetry:0+notify',
];

export interface AgentCaps {
  /** Feature de telemetría (`+notify`) anunciada. */
  telemetryNotify: boolean;
  /** XEP-0050 COMMANDS anunciado. */
  commands: boolean;
  /** Agente OpenClaw = telemetría + COMMANDS. */
  isAgent: boolean;
}

export type CapsStatus = 'unknown' | 'loading' | 'ready' | 'error';

export interface CapsEntry {
  status: CapsStatus;
  caps?: AgentCaps;
}

const entries = new Map<string, CapsEntry>();
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();

function bareJid(jid: string): string {
  return jid.split('/')[0] ?? jid;
}

function notify() {
  for (const cb of listeners) cb();
}

const UNKNOWN_ENTRY: CapsEntry = Object.freeze({ status: 'unknown' });

export function getCapsSnapshot(jid: string): CapsEntry {
  return entries.get(bareJid(jid)) ?? UNKNOWN_ENTRY;
}

export function subscribeCaps(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function resetCapsCache() {
  entries.clear();
  inflight.clear();
  notify();
}

function parseCapsFeatures(query: Element | undefined): AgentCaps {
  const features = new Set<string>();
  for (const feature of query?.getChildren('feature') ?? []) {
    const v = feature.attrs.var as string | undefined;
    if (v) features.add(v);
  }
  const telemetryNotify = AGENT_TELEMETRY_NOTIFY.some((f) => features.has(f));
  const commands = features.has(COMMAND_NS);
  return { telemetryNotify, commands, isAgent: telemetryNotify && commands };
}

async function probe(bare: string): Promise<void> {
  entries.set(bare, { status: 'loading' });
  notify();
  const client = usableClient();
  if (!client) {
    entries.set(bare, { status: 'unknown' });
    notify();
    return;
  }
  try {
    const result = await client.iqCaller.request(
      xml(
        'iq',
        { type: 'get', to: bare, id: `caps-${Date.now().toString(36)}` },
        xml('query', { xmlns: DISCO_INFO_NS }),
      ),
      10000,
    );
    const query = result.getChild('query', DISCO_INFO_NS);
    entries.set(bare, { status: 'ready', caps: parseCapsFeatures(query) });
  } catch {
    entries.set(bare, { status: 'error' });
  }
  notify();
}

/** Pide disco#info del contacto y la cachea. Idempotente y con dedupe. */
export async function fetchCaps(jid: string): Promise<CapsEntry> {
  const bare = bareJid(jid);
  const cached = entries.get(bare);
  if (cached && (cached.status === 'ready' || cached.status === 'loading')) return cached;
  let pending = inflight.get(bare);
  if (!pending) {
    pending = probe(bare).finally(() => {
      inflight.delete(bare);
    });
    inflight.set(bare, pending);
  }
  await pending;
  return entries.get(bare) ?? { status: 'error' };
}

/** Caps del contacto (snapshot estable); dispara el fetch al montar. */
export function useAgentCaps(jid: string): CapsEntry {
  const bare = bareJid(jid);
  useEffect(() => {
    void fetchCaps(bare);
  }, [bare]);
  return useSyncExternalStore(
    useCallback((cb: () => void) => subscribeCaps(cb), []),
    () => getCapsSnapshot(bare),
  );
}
