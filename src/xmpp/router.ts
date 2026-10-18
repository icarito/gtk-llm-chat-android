/**
 * Despacho de stanzas entrantes a los módulos de cada feature. El orden es
 * parte del contrato: lo que consume una rama no llega a las siguientes.
 */
import type { Element } from '@xmpp/xml';
import type { StanzaCtx } from '@/xmpp/session';
import { handleDiscoInfoGet } from '@/xmpp/disco';
import { handlePresence } from '@/xmpp/roster';
import { handlePubsubEvent } from '@/xmpp/pep';
import { handleMamResult, isMamResult } from '@/xmpp/mam';
import { handleCarbon, handleChatMessage, isCarbon } from '@/xmpp/inbound';

export async function routeStanza(stanza: Element, ctx: StanzaCtx): Promise<void> {
  // XEP-0030: alguien pregunta qué soportamos.
  if (handleDiscoInfoGet(stanza, ctx)) return;

  if (stanza.is('presence')) {
    handlePresence(stanza, ctx);
    return;
  }

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

  await handleChatMessage(stanza, ctx);
}
