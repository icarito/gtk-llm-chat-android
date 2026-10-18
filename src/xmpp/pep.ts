/**
 * XEP-0163 PEP: telemetría del agente (+ nodo legacy), avatares XEP-0084 y
 * device list de OMEMO. Los nuevos parsers PEP viven en src/xmpp/pep/.
 */
import { xml } from '@xmpp/client';
import * as FileSystem from 'expo-file-system';
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
import { bareJid } from '@/xmpp/parse';
import { usableClient } from '@/xmpp/session';

/** PEP telemetry cache: bare_jid -> telemetry dict parsed from pubsub events. */
const agentTelemetry = new Map<string, Record<string, unknown>>();

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
 * Extrae la telemetría del <telemetry/> publicado en el nodo PEP.
 * Espejo de parse_telemetry() en xmpp_client.py del cliente GTK.
 *
 * El payload que emite el gateway anida los números en atributos, no en texto:
 *
 *   <telemetry xmlns='urn:nanoclaw:telemetry:0'>
 *     <context used='42000' max='128000'/>
 *     <tokens total='…' input='…' output='…' requests='…'/>
 *     <cost usd='0.0431'/>
 *     <model>deepseek-v4-pro</model>
 *     <tool>bash</tool>
 *   </telemetry>
 *
 * Nunca inventa ceros: "sin dato" y "cero" son cosas distintas para una barra de
 * progreso, así que una clave ausente se queda ausente.
 */
export function parseTelemetry(item: Element): Record<string, unknown> {
  const telemetry: Record<string, unknown> = {};
  const tlm = item.getChild('telemetry', TELEMETRY_NODE) ?? item.getChild('telemetry', LEGACY_TELEMETRY_NODE);
  if (!tlm) return telemetry;

  const intAttr = (node: Element | undefined, attr: string): number | undefined => {
    const val = node?.attrs[attr] as string | undefined;
    if (val === undefined || val === '') return undefined;
    const n = Number(val);
    return Number.isFinite(n) ? n : undefined;
  };

  // El contexto sólo sirve por pares: un `used` sin `max` (o con max=0) no da
  // fracción que pintar, así que se descarta entero en vez de publicar la mitad.
  const context = tlm.getChild('context');
  const used = intAttr(context, 'used');
  const max = intAttr(context, 'max');
  if (used !== undefined && max) {
    telemetry.context_used = used;
    telemetry.context_max = max;
  }

  const tokens = tlm.getChild('tokens');
  if (tokens) {
    for (const key of ['total', 'input', 'output', 'requests'] as const) {
      const value = intAttr(tokens, key);
      if (value !== undefined) telemetry[`tokens_${key}`] = value;
    }
  }

  const cost = Number(tlm.getChild('cost')?.attrs.usd);
  if (Number.isFinite(cost)) telemetry.cost = cost;

  for (const tag of ['model', 'tool'] as const) {
    const text = tlm.getChildText(tag);
    if (text) telemetry[tag] = text;
  }

  return telemetry;
}

export function getAgentTelemetry(bare: string): Record<string, unknown> | undefined {
  return agentTelemetry.get(bare);
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
        const telemetry = parseTelemetry(item);
        if (Object.keys(telemetry).length > 0) {
          agentTelemetry.set(bareJid, telemetry);
          notifyTelemetry(bareJid, telemetry);
          return;
        }
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
      const telemetry = parseTelemetry(item);
      if (Object.keys(telemetry).length > 0) {
        agentTelemetry.set(bare, telemetry);
        notifyTelemetry(bare, telemetry);
      }
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
