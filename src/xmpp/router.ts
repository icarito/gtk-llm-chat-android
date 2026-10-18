/**
 * Despacho de stanzas entrantes a los módulos de cada feature. El orden es
 * parte del contrato: lo que consume una rama no llega a las siguientes.
 */
import type { Element } from '@xmpp/xml';
import type { StanzaCtx } from '@/xmpp/session';
import { handleDiscoInfoGet } from '@/xmpp/disco';
import { handlePresence } from '@/xmpp/roster';
import { handleBookmarksEvent, handleMucMessage, handleMucPresence } from '@/xmpp/rooms';
import { handlePubsubEvent } from '@/xmpp/pep';
import { handleOmemo2Event } from '@/xmpp/omemo2';
import { handleMamResult, isMamResult } from '@/xmpp/mam';
import { handleCarbon, handleChatMessage, isCarbon } from '@/xmpp/inbound';

export async function routeStanza(stanza: Element, ctx: StanzaCtx): Promise<void> {
  // XEP-0030: alguien pregunta qué soportamos.
  if (handleDiscoInfoGet(stanza, ctx)) return;

  if (stanza.is('presence')) {
    // Presencia de sala ANTES que la de contactos: un ocupante nunca debe
    // poner en verde a un contacto (ver rooms.ts).
    if (handleMucPresence(stanza, ctx)) return;
    handlePresence(stanza, ctx);
    return;
  }

  // XEP-0402: marcadores (antes del PEP genérico, que descarta nodos ajenos).
  if (handleBookmarksEvent(stanza, ctx)) return;

  // XEP-0384 v0.8: device list OMEMO 2 (antes del PEP genérico, que descarta nodos ajenos).
  if (handleOmemo2Event(stanza)) return;

  // XEP-0163 PEP (telemetría, avatares, device list OMEMO).
  if (handlePubsubEvent(stanza)) return;

  if (!stanza.is('message')) return;

  // XEP-0313: antes del filtro chat/groupchat, son wrappers sin type ni body propio.
  if (isMamResult(stanza)) {
    await handleMamResult(stanza, ctx);
    return;
  }

  if (isCarbon(stanza)) {
    await handleCarbon(stanza, ctx);
    return;
  }

  // Invitaciones y asunto de sala (no son chat/groupchat con cuerpo).
  if (handleMucMessage(stanza)) return;

  await handleChatMessage(stanza, ctx);
}
