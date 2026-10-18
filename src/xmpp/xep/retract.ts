import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import { NS_FALLBACK } from './reply';

export const NS_RETRACT = 'urn:xmpp:message-retract:1';
export const NS_HINTS = 'urn:xmpp:hints';
export const RETRACT_FALLBACK_BODY = 'Este mensaje fue eliminado';

export type RetractMessageType = 'chat' | 'groupchat';

/**
 * XEP-0424: retracta un mensaje propio. El body y el fallback XEP-0428 existen
 * para clientes sin soporte; el `<retract id>` es el evento real para quienes
 * lo soportan. El mensaje retractado se identifica igual que en reacciones: en
 * groupchat, por el `stanza-id` del MUC.
 */
export function buildRetract(
  to: string,
  type: RetractMessageType,
  targetId: string,
): Element {
  return xml(
    'message',
    { to, type },
    xml('retract', { xmlns: NS_RETRACT, id: targetId }),
    xml('body', {}, RETRACT_FALLBACK_BODY),
    xml('fallback', { xmlns: NS_FALLBACK, for: NS_RETRACT }),
    xml('store', { xmlns: NS_HINTS }),
  );
}

export function parseRetract(msg: Element): string | null {
  const retract = msg.getChild('retract', NS_RETRACT);
  if (!retract) return null;
  return retract.attrs.id || null;
}
