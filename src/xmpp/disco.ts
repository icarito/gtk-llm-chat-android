/** XEP-0030 (disco#info) y XEP-0115 (caps): lo que anunciamos y la presencia inicial. */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import type { XmppAccountConfig } from '@/types/xmpp';
import { Omemo } from '@/xmpp/xep-0384';
import { NODE_DEVICES } from '@/xmpp/omemo2';
import { session } from '@/xmpp/session';
import {
  AVATAR_METADATA_NODE,
  CAPS_NODE,
  CHAT_STATES_NS,
  DISCO_INFO_NS,
} from '@/xmpp/ns';
import { capsNotifyFeatures } from '@/xmpp/pep/namespaces';
import { NS_BOOKMARKS } from '@/xmpp/xep/bookmarks';
import { base64FromBytes, sha1Hex } from '@/xmpp/sha1';
import type { StanzaCtx } from '@/xmpp/session';

/**
 * Lo que anunciamos por disco#info (y, resumido, por XEP-0115 caps).
 *
 * `<nodo>+notify` es notificación filtrada (XEP-0163): el servidor SÓLO nos
 * entrega los eventos PEP de los nodos que pedimos aquí. Sin esta línea el
 * agente publica su telemetría y nosotros no recibimos nada — no hay error, no
 * hay stanza, simplemente no llega.
 */
const CAPS_FEATURES = [
  DISCO_INFO_NS,
  // Telemetría (OpenClaw + legacy) y hooks de actividad/aprobación/progreso.
  ...capsNotifyFeatures(),
  // Avatares XEP-0084: sin el +notify del nodo de metadata el servidor no nos
  // avisa cuando un contacto cambia su foto.
  `${AVATAR_METADATA_NODE}+notify`,
  CHAT_STATES_NS,
  // XEP-0402: avisos de marcadores de salas (autojoin en vivo desde otro cliente).
  `${NS_BOOKMARKS}+notify`,
  // Llamadas Jingle (audio 1:1): que Dino/otros clientes habiliten el botón.
  'urn:xmpp:jingle:1',
  'urn:xmpp:jingle:apps:rtp:1',
  'urn:xmpp:jingle:apps:rtp:audio',
  'urn:xmpp:jingle:transports:ice-udp:1',
  'urn:xmpp:jingle:transports:dtls-srtp:1',
  'urn:xmpp:jingle-message:0',
];

export function getActiveCapsFeatures(): string[] {
  const features = [...CAPS_FEATURES];
  if (Omemo.isEnabled()) {
    features.push('eu.siacs.conversations.axolotl+notify');
  }
  // OMEMO 2: sin el +notify no recibimos los cambios de device list de los contactos.
  if (session.account?.omemoEnabled) features.push(`${NODE_DEVICES}+notify`);
  return features;
}

/**
 * XEP-0115 caps. El `ver` es AHORA el SHA-1 real de la forma canónica
 * (identidad + features ordenados). Antes era un identificador opaco: el
 * servidor (Prosody) no valida el hash, pero clientes como Dino SÍ lo
 * verifican contra disco#info y rechazan un ver que no corresponda (botón
 * de llamada deshabilitado). Al derivarse del contenido, cualquier cambio de
 * features cambia el ver automáticamente.
 */
export function capsVer(_config: XmppAccountConfig): string {
  // Dino computa la identidad como "category/type//name" (doble barra antes
  // del nombre) en su verificación XEP-0115. Usar "category/type/name"
  // (barra simple) genera un hash distinto y Dino descarta nuestras caps.
  const parts = ['client/phone//gtk-llm-chat-android'];
  for (const feature of [...getActiveCapsFeatures()].sort()) parts.push(feature);
  const canonical = parts.join('<') + '<';
  const hex = sha1Hex(canonical);
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return base64FromBytes(bytes);
}

/** Presencia inicial con caps. Sin ella el servidor no nos enruta mensajes entrantes. */
export function sendInitialPresence(ctx: StanzaCtx) {
  ctx.client.send(xml('presence', { priority: '8' }, xml('c', {
    xmlns: 'http://jabber.org/protocol/caps',
    hash: 'sha-1',
    node: CAPS_NODE,
    ver: capsVer(ctx.config),
  }))).catch(() => {});
}

/** XEP-0030 disco#items: no publicamos nodos; respuesta vacía es correcta. */
export function handleDiscoItemsGet(stanza: Element, ctx: StanzaCtx): boolean {
  if (!(stanza.is('iq') && stanza.attrs.type === 'get')) return false;
  const query = stanza.getChild('query', 'http://jabber.org/protocol/disco#items');
  if (!query) return false;
  const from = stanza.attrs.from as string | undefined;
  const id = stanza.attrs.id as string | undefined;
  const node = query.attrs.node as string | undefined;
  // eslint-disable-next-line no-console
  console.warn(`[disco] info get de ${from ?? ''} node=${node ?? ''}`);
  ctx.client.send(
    xml(
      'iq',
      { type: 'result', ...(from ? { to: from } : {}), ...(id ? { id } : {}) },
      xml('query', { xmlns: 'http://jabber.org/protocol/disco#items', ...(node ? { node } : {}) }),
    ),
  ).catch(() => {});
  return true;
}

/** XEP-0199 ping (y iq get vacío): responder siempre, jamás error. */
export function handlePingGet(stanza: Element, ctx: StanzaCtx): boolean {
  if (!(stanza.is('iq') && stanza.attrs.type === 'get')) return false;
  if (stanza.getChild('ping', 'urn:xmpp:ping')) {
    sendIqResult(stanza, ctx);
    return true;
  }
  if (stanza.getChildElements().length === 0) {
    // Ping "vacío" (algunos clientes no incluyen <ping/>).
    sendIqResult(stanza, ctx);
    return true;
  }
  return false;
}

function sendIqResult(stanza: Element, ctx: StanzaCtx): void {
  const from = stanza.attrs.from as string | undefined;
  const id = stanza.attrs.id as string | undefined;
  // eslint-disable-next-line no-console
  console.warn(`[disco] resultado para goq ${id ?? ''} de ${from ?? ''}`);
  ctx.client.send(xml('iq', { type: 'result', ...(from ? { to: from } : {}), ...(id ? { id } : {}) })).catch(() => {});
}

/**
 * XEP-0030: alguien pregunta qué soportamos.
 * El servidor lo pregunta cuando ve un caps `ver` que no tiene cacheado.
 * Es el único momento en que puede enterarse de que queremos el nodo de
 * telemetría con +notify; si no contestamos, no nos manda los eventos PEP.
 * Devuelve true si la stanza era un disco#info get (ya contestada).
 */
export function handleDiscoInfoGet(stanza: Element, ctx: StanzaCtx): boolean {
  if (!(stanza.is('iq') && stanza.attrs.type === 'get')) return false;
  const query = stanza.getChild('query', DISCO_INFO_NS);
  if (!query) return false;
  const from = stanza.attrs.from as string | undefined;
  const id = stanza.attrs.id as string | undefined;
  // Devolvemos el mismo `node` que nos preguntaron (o ninguno): un
  // disco#info a un node concreto debe responder por ese node.
  const node = query.attrs.node as string | undefined;
  ctx.client.send(
    xml(
      'iq',
      { type: 'result', ...(from ? { to: from } : {}), ...(id ? { id } : {}) },
      xml(
        'query',
        { xmlns: DISCO_INFO_NS, ...(node ? { node } : {}) },
        xml('identity', { category: 'client', type: 'phone', name: 'gtk-llm-chat-android' }),
        ...getActiveCapsFeatures().map((feature) => xml('feature', { var: feature })),
      ),
    ),
  ).catch(() => {});
  return true;
}
