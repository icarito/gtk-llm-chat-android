import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';

export const NS_REACTIONS = 'urn:xmpp:reactions:0';
export const NS_HINTS = 'urn:xmpp:hints';

export type ReactionsMessageType = 'chat' | 'groupchat';

export interface ParsedReactions {
  targetId: string;
  emojis: string[];
}

/**
 * Construye un mensaje XEP-0444 con el conjunto COMPLETO de reacciones.
 *
 * En `groupchat` el `targetId` debe ser el `stanza-id` que el MUC asigna al
 * mensaje (XEP-0359, `<stanza-id by="room@conference.example"/>`), no el id
 * original del cliente: los demás ocupantes no ven ese id. En `chat` se usa el
 * id del mensaje recibido.
 */
export function buildReactions(
  to: string,
  type: ReactionsMessageType,
  targetId: string,
  emojis: string[],
): Element {
  const reactions = xml(
    'reactions',
    { xmlns: NS_REACTIONS, id: targetId },
    ...emojis.map((emoji) => xml('reaction', {}, emoji)),
  );

  return xml(
    'message',
    { to, type },
    reactions,
    xml('store', { xmlns: NS_HINTS }),
  );
}

export function parseReactions(msg: Element): ParsedReactions | null {
  const reactions = msg.getChild('reactions', NS_REACTIONS);
  if (!reactions) return null;

  return {
    targetId: reactions.attrs.id ?? '',
    emojis: reactions.getChildren('reaction').map((reaction) => reaction.text()),
  };
}
