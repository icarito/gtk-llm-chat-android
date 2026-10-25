import { xml } from '@xmpp/xml';
import type { Element } from '@xmpp/xml';
import { MESSAGE_NS, RTP_NS } from './types';
import type { JingleMessage } from './types';

/** Carbons XEP-0280 / Forwarded XEP-0293. */
const CARBONS_NS = 'urn:xmpp:carbons:2';
const FORWARD_NS = 'urn:xmpp:forward:0';

/**
 * Desenvuelve un jingle-message dentro de un carbon (XEP-0280): el `propose`
 * de un peer no lleva body, y mod_message de Prosody lo entrega SÓLO al
 * `top_resources` — al resto de nuestros dispositivos llega como
 * `<received><forwarded><message>` de la PROPIA cuenta. Devuelve el mensaje
 * interior y la clase del carbon ('received' = mensaje del peer duplicado;
 * 'sent' = eco de una llamada nuestra saliente). Devuelve null si no hay
 * carbon con jingle-message (el caller NO debe confiar en esto sin chequear
 * que el wrapper venga de nuestra cuenta: XEP-0280 §6).
 */
export function unwrapCarbonJingleMessage(
  el: Element,
): { message: Element; kind: 'received' | 'sent' } | null {
  if (!el.is('message')) return null;
  const tag = el.getChild('received', CARBONS_NS) ?? el.getChild('sent', CARBONS_NS);
  if (!tag) return null;
  const kind = tag.is('received', CARBONS_NS) ? 'received' : 'sent';
  const inner = tag.getChild('forwarded', FORWARD_NS)?.getChild('message');
  if (!inner) return null;
  return { message: inner, kind };
}

/**
 * XEP-0353: cada acción es un ELEMENTO DISTINTO, hijo directo de <message>
 * (`<propose xmlns='urn:xmpp:jingle-message:0' id='...'/>`), no un
 * `<jingle-message action='...'/>` envuelto: el XEP no define ningún
 * contenedor y Dino/AnotherIM (xmpp-rs / Conversations) envían elementos
 * individuales (example 1 del XEP). Sólo <propose/> lleva
 * <description/>; el resto puede llevar <reason/> (omitted por fase 1).
 */
export const JINGLE_MESSAGE_ACTIONS = ['propose', 'accept', 'reject', 'ringing', 'retract', 'proceed', 'finish'] as const;

export function parseJingleMessage(el: Element): JingleMessage | null {
  if (!el.is('message')) return null;
  for (const action of JINGLE_MESSAGE_ACTIONS) {
    const child = el.getChild(action, MESSAGE_NS);
    if (!child) continue;
    const id = child.attrs.id as string | undefined;
    if (!id) return null;
    const descEl = child.getChild('description', RTP_NS);
    if (descEl) {
      const media = descEl.attrs.media as 'audio' | 'video';
      if (media !== 'audio' && media !== 'video') return null;
      return { action, id, description: { media } };
    }
    return { action, id };
  }
  return null;
}

/**
 * `<message type='chat'>` (obligatorio) con el elemento de acción y el
 * `<store/>` de XEP-0334 (los mensajes del protocolo DEBEN archivarse para
 * que MAM sincronice el estado de la llamada entre dispositivos). El `to`
 * lo completa el caller (maneja bare para propose, full para el resto).
 */
export function buildJingleMessage(
  action: JingleMessage['action'],
  opts: { id: string; media?: 'audio' | 'video' },
): Element {
  // El schema de XEP-0353: sólo <propose/> lleva <description/>; el resto
  // son elementos "vacíos".
  const children: Element[] = [];
  if (action === 'propose' && opts.media) {
    children.push(xml('description', { xmlns: RTP_NS, media: opts.media }));
  }
  const actionEl = xml(action, { xmlns: MESSAGE_NS, id: opts.id }, ...children);
  return xml('message', { type: 'chat' }, actionEl, xml('store', { xmlns: 'urn:xmpp:hints' }));
}
