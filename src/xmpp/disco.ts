/** XEP-0030 (disco#info) y XEP-0115 (caps): lo que anunciamos y la presencia inicial. */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import type { XmppAccountConfig } from '@/types/xmpp';
import { Omemo } from '@/xmpp/xep-0384';
import {
  AVATAR_METADATA_NODE,
  CAPS_NODE,
  CHAT_STATES_NS,
  DISCO_INFO_NS,
} from '@/xmpp/ns';
import { capsNotifyFeatures } from '@/xmpp/pep/namespaces';
import { NS_BOOKMARKS } from '@/xmpp/xep/bookmarks';
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
];

export function getActiveCapsFeatures(): string[] {
  const features = [...CAPS_FEATURES];
  if (Omemo.isEnabled()) {
    features.push('eu.siacs.conversations.axolotl+notify');
  }
  return features;
}

// XEP-0115 caps. El `ver` NO es el hash SHA-1 que manda la spec: es un
// identificador opaco de este conjunto de features. No hay SHA-1 en el bundle
// de RN (ni una dependencia de cripto que valga la pena arrastrar por esto).
//
// Funciona porque el servidor cachea por node#ver y, cuando ve un ver que no
// conoce, nos pregunta por disco#info al recurso completo — y eso sí lo
// respondemos (handler de iq/get más abajo). Prosody no valida el hash.
//
// OJO, DOS TRAMPAS, y las dos fallan EN SILENCIO (no llega telemetría, sin
// error ni stanza de aviso):
//  1. Si cambias CAPS_FEATURES, SUBE ESTA VERSIÓN. Un servidor que cacheó el
//     ver anterior no vuelve a preguntar y los features nuevos no se anuncian.
//  2. Si algún día el servidor sí verifica el hash, esto deja de funcionar y
//     habrá que calcular el ver de verdad (el gateway lo hace en
//     capsVerHash(), src/channels/xmpp.ts) — con una implementación de SHA-1.
// SUBIDA A MANO al añadir el +notify de avatares: el servidor cachea por
// node#ver y, con el ver anterior, no vuelve a preguntar por disco#info —
// los features nuevos no se anunciarían y no llegarían los avatares.
// v4: + chatstates (XEP-0085). v8: + hooks OpenClaw (capsNotifyFeatures) + bookmarks+notify (XEP-0402).
// Con OMEMO se usa otro ver para forzar a servidor/contactos (incl. OpenClaw) a re-consultar disco#info
// (XEP-0115) y detectar eu.siacs.conversations.axolotl+notify de inmediato.
export function capsVer(config: XmppAccountConfig): string {
  return config.omemoEnabled
    ? 'v9-telemetry-hooks-avatar-chatstates-bookmarks-omemo'
    : 'v8-telemetry-hooks-avatar-chatstates-bookmarks';
}

/** Presencia inicial con caps. Sin ella el servidor no nos enruta mensajes entrantes. */
export function sendInitialPresence(ctx: StanzaCtx) {
  ctx.client.send(xml('presence', {}, xml('c', {
    xmlns: 'http://jabber.org/protocol/caps',
    hash: 'sha-1',
    node: CAPS_NODE,
    ver: capsVer(ctx.config),
  }))).catch(() => {});
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
