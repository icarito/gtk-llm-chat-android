/**
 * XEP-0163 PEP: telemetría del agente (+ nodo legacy), avatares XEP-0084 y
 * device list de OMEMO. Los nuevos parsers PEP viven en src/xmpp/pep/.
 */
import { xml } from '@xmpp/client';
import * as FileSystem from 'expo-file-system/legacy';
import type { Element } from '@xmpp/xml';
import { Omemo } from '@/xmpp/xep-0384';
import {
  AVATAR_DATA_NODE,
  AVATAR_METADATA_NODE,
  LEGACY_TELEMETRY_NODE,
  PUBSUB_EVENT_NS,
  PUBSUB_NS,
  TELEMETRY_NODE,
} from '@/xmpp/ns';
import { agents } from '@/xmpp/agents';
import { NS_HOOKS_ACTIVITY, NS_HOOKS_APPROVAL, NS_HOOKS_PROGRESS } from '@/xmpp/pep/namespaces';
import { parseHook } from '@/xmpp/pep/hooks';
import { parseTelemetry as parseTelemetryFull, type AgentTelemetry } from '@/xmpp/pep/telemetry';
import { bareJid } from '@/xmpp/parse';
import { handleFleetEvent } from '@/xmpp/fleet';
import { usableClient } from '@/xmpp/session';

const HOOK_NODES = [NS_HOOKS_ACTIVITY, NS_HOOKS_APPROVAL, NS_HOOKS_PROGRESS];

/** bare_jid -> file:// del avatar cacheado (XEP-0084). */
const avatarUris = new Map<string, string>();
export const avatarListeners = new Set<(jid: string, uri: string | null) => void>();
/** Latest advertised avatar hash per contact, used to ignore stale IQ replies. */
const avatarHashes = new Map<string, string>();
let avatarIqSequence = 0;

function nextAvatarIqId(kind: 'meta' | 'data'): string {
  avatarIqSequence = (avatarIqSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `avatar-${kind}-${Date.now().toString(36)}-${avatarIqSequence.toString(36)}`;
}

function notifyAvatars(jid: string) {
  const uri = avatarUris.get(jid) ?? null;
  for (const listener of avatarListeners) listener(jid, uri);
}

/**
 * Pide los bytes del avatar y los deja en caché de disco.
 *
 * El fichero se nombra por el SHA-1: en XEP-0084 el hash ES la identidad de la
 * imagen, así que un fichero por hash nunca queda obsoleto y al reabrir la app
 * no hay que volver a pedir nada.
 */
async function fetchAvatarData(bare: string, sha: string): Promise<void> {
  try {
    avatarHashes.set(bare, sha);
    const dir = `${FileSystem.cacheDirectory}avatars/`;
    const path = `${dir}${sha}.img`;
    const existing = await FileSystem.getInfoAsync(path);
    if (existing.exists) {
      if (avatarHashes.get(bare) !== sha) return;
      avatarUris.set(bare, path);
      notifyAvatars(bare);
      return;
    }
    const client = usableClient();
    if (!client) return;

    const result = await client.iqCaller.request(
      xml('iq', { type: 'get', to: bare, id: nextAvatarIqId('data') },
        xml('pubsub', { xmlns: PUBSUB_NS },
          xml('items', { node: AVATAR_DATA_NODE }, xml('item', { id: sha })))),
      15000,
    );
    const base64 = result
      .getChild('pubsub', PUBSUB_NS)
      ?.getChild('items')
      ?.getChildren('item')
      ?.map((item: Element) => item.getChild('data', AVATAR_DATA_NODE)?.text())
      .find((text?: string) => Boolean(text));
    if (!base64) return;
    if (avatarHashes.get(bare) !== sha) return;

    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    await FileSystem.writeAsStringAsync(path, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (avatarHashes.get(bare) !== sha) return;
    avatarUris.set(bare, path);
    notifyAvatars(bare);
  } catch {
    // Un avatar que no llega no debe romper el chat.
  }
}

export type AgentTelemetryListener = (jid: string, telemetry: Record<string, unknown>) => void;
export const telemetryListeners = new Set<AgentTelemetryListener>();

function notifyTelemetry(jid: string, telemetry: Record<string, unknown>) {
  telemetryListeners.forEach((fn) => fn(jid, telemetry));
}

/**
 * Telemetría en el formato plano que consume la pantalla de chat
 * (context_used, tokens_total, cost…), derivada del parser completo de
 * src/xmpp/pep/telemetry.ts. Nunca inventa ceros: una clave ausente se queda
 * ausente, y el contexto sólo sirve por pares (used + max no nulo).
 */
function toFlat(t: AgentTelemetry): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  if (t.context.used !== undefined && t.context.max) {
    flat.context_used = t.context.used;
    flat.context_max = t.context.max;
  }
  for (const key of ['total', 'input', 'output', 'requests'] as const) {
    if (t.tokens[key] !== undefined) flat[`tokens_${key}`] = t.tokens[key];
  }
  if (t.cost.usd !== undefined) flat.cost = t.cost.usd;
  if (t.model) flat.model = t.model;
  if (t.tool) flat.tool = t.tool;
  return flat;
}

/** Fachada compatible: <item>/<telemetry/> -> dict plano ({} si no hay datos). */
export function parseTelemetry(item: Element): Record<string, unknown> {
  const t = parseTelemetryFull(item);
  return t ? toFlat(t) : {};
}

/** Aplica la telemetría al store de agentes y avisa a los listeners clásicos. */
function applyAgentTelemetry(bare: string, t: AgentTelemetry): boolean {
  const flat = toFlat(t);
  const hasData = Object.keys(flat).length > 0;
  if (!hasData && !t.activity && !t.availability) return false;
  agents.applyTelemetry(bare, t);
  if (hasData) notifyTelemetry(bare, flat);
  return true;
}

export function getAgentTelemetry(bare: string): Record<string, unknown> | undefined {
  const t = agents.get(bare)?.telemetry;
  return t ? toFlat(t) : undefined;
}

/** file:// del avatar cacheado del contacto (XEP-0084), si publicó uno. */
export function getAvatarUri(bare: string): string | null {
  return avatarUris.get(bare) ?? null;
}

/**
 * Pide el avatar actual del contacto.
 *
 * Los eventos PEP sólo llegan cuando el contacto *publica*: uno que puso su
 * avatar antes de que nos conectáramos no emite nada, así que sin esto no lo
 * veríamos nunca (mismo motivo que fetchAgentTelemetry).
 */
export async function fetchAvatar(bareJid: string): Promise<void> {
  if (avatarUris.has(bareJid)) return;
  const client = usableClient();
  if (!client) return;
  try {
    const result = await client.iqCaller.request(
      xml('iq', { type: 'get', to: bareJid, id: nextAvatarIqId('meta') },
        xml('pubsub', { xmlns: PUBSUB_NS },
          xml('items', { node: AVATAR_METADATA_NODE, max_items: '1' }))),
      15000,
    );
    const info = result
      .getChild('pubsub', PUBSUB_NS)
      ?.getChild('items')
      ?.getChildren('item')
      ?.map((item: Element) => item.getChild('metadata', AVATAR_METADATA_NODE)?.getChild('info'))
      .find((node?: Element) => Boolean(node?.attrs?.id));
    const sha = info?.attrs.id as string | undefined;
    if (sha) await fetchAvatarData(bareJid, sha);
  } catch {
    // Lo normal si el contacto no publicó avatar.
  }
}

/**
 * Pide el valor actual del nodo de telemetría del agente.
 *
 * Los eventos PEP sólo llegan cuando el agente *publica* algo nuevo, así que
 * un agente que lleva rato quieto no emitiría nada y la barra de contexto se
 * quedaría vacía para siempre. Al abrir la conversación preguntamos por el
 * último valor publicado (el nodo guarda max_items=1).
 */
export async function fetchAgentTelemetry(bareJid: string): Promise<void> {
  const client = usableClient();
  if (!client) return;
  // Probar primero el nodo actual (OpenClaw) y, si el agente aún no migró
  // y ese nodo no existe, reintentar con el legacy (NanoClaw) antes de
  // rendirse — ver el rename documentado junto a TELEMETRY_NODE arriba.
  for (const node of [TELEMETRY_NODE, LEGACY_TELEMETRY_NODE]) {
    try {
      const result = await client.iqCaller.request(
        xml(
          'iq',
          { type: 'get', to: bareJid },
          xml(
            'pubsub',
            { xmlns: 'http://jabber.org/protocol/pubsub' },
            xml('items', { node, max_items: '1' }),
          ),
        ),
        10000,
      );
      const items = result
        .getChild('pubsub', 'http://jabber.org/protocol/pubsub')
        ?.getChild('items')
        ?.getChildren('item') ?? [];
      for (const item of items) {
        const telemetry = parseTelemetryFull(item);
        if (telemetry && applyAgentTelemetry(bareJid, telemetry)) return;
      }
    } catch {
      // Lo normal si el contacto no es un agente, o si no tiene este nodo
      // en particular (probamos el otro namespace a continuación). Si
      // fallan los dos nodos, la pantalla se queda con lo cacheado en
      // agentTelemetry -- que puede ser viejo (el mapa vive mientras el
      // proceso de la app esté vivo) -- así que un fallo de red aquí no es
      // inocuo, sólo no hay mejor señal disponible que degradarse en
      // silencio a ese valor.
    }
  }
}

/** Evento PEP entrante. Devuelve true si la stanza traía un <event/> pubsub (ya consumida). */
export function handlePubsubEvent(stanza: Element): boolean {
  const pubsubEvent = stanza.getChild('event', PUBSUB_EVENT_NS);
  if (!pubsubEvent) return false;
  const items = pubsubEvent.getChild('items');
  const node = items?.attrs.node as string | undefined;
  if (node === TELEMETRY_NODE || node === LEGACY_TELEMETRY_NODE) {
    const from = stanza.attrs.from as string | undefined;
    if (!from) return true;
    const bare = bareJid(from);
    for (const item of items?.getChildren('item') ?? []) {
      const telemetry = parseTelemetryFull(item);
      if (telemetry) applyAgentTelemetry(bare, telemetry);
    }
    return true;
  }
  if (handleFleetEvent(stanza.attrs.from as string | undefined, node, items?.getChildren('item') ?? [])) return true;
  if (HOOK_NODES.includes(node ?? '')) {
    const from = stanza.attrs.from as string | undefined;
    if (!from) return true;
    for (const item of items?.getChildren('item') ?? []) {
      const hook = parseHook(item, node as string);
      if (hook) agents.applyHook(bareJid(from), hook);
    }
    return true;
  }
  if (node === 'eu.siacs.conversations.axolotl.devicelist') {
    const from = stanza.attrs.from as string | undefined;
    if (!from) return true;
    const bare = bareJid(from);
    const listNode = items?.getChild('item')?.getChild('list', 'eu.siacs.conversations.axolotl');
    if (listNode) {
      const devices = listNode
        .getChildren('device')
        .map((d: Element) => parseInt(d.attrs.id as string, 10))
        .filter((id: number) => !isNaN(id));
      Omemo.handleDeviceListUpdate(bare, devices);
    }
    return true;
  }
  if (node === AVATAR_METADATA_NODE) {
    const from = stanza.attrs.from as string | undefined;
    if (!from) return true;
    const bare = bareJid(from);
    const item = items?.getChildren('item')?.[0];
    // Metadata sin <info> = el contacto retiró su avatar.
    const info = item?.getChild('metadata', AVATAR_METADATA_NODE)?.getChild('info');
    const sha = info?.attrs.id as string | undefined;
    if (!sha) {
      avatarHashes.delete(bare);
      avatarUris.delete(bare);
      notifyAvatars(bare);
      return true;
    }
    void fetchAvatarData(bare, sha);
    return true;
  }
  // Other pubsub nodes are ignored.
  return true;
}
