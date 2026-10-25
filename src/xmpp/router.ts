/**
 * Despacho de stanzas entrantes a los módulos de cada feature. El orden es
 * parte del contrato: lo que consume una rama no llega a las siguientes.
 */
import type { Element } from '@xmpp/xml';
import type { StanzaCtx } from '@/xmpp/session';
import { handleDiscoInfoGet, handleDiscoItemsGet, handlePingGet } from '@/xmpp/disco';
import { handlePresence } from '@/xmpp/roster';
import { handleBookmarksEvent, handleMucMessage, handleMucPresence } from '@/xmpp/rooms';
import { handlePubsubEvent } from '@/xmpp/pep';
import { handleOmemo2Event } from '@/xmpp/omemo2';
import { handleMamResult, isMamResult } from '@/xmpp/mam';
import { bareJid } from '@/xmpp/parse';
import { handleCarbon, handleChatMessage, isCarbon } from '@/xmpp/inbound';
import { handleJingleIq, handleJingleMessage } from '@/xmpp/jingle/manager';

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

  // XEP-0166/0353: llamadas Jingle (IQ y mensajes de iniciación).
  if (stanza.is('iq')) {
    if (await handleJingleIq(stanza, ctx)) return;
    // XEP-0030 disco#info/items y XEP-0199 ping: responder siempre (jamás error),
    // o clientes como Dino abortan llamadas al no recibir respuesta.
    if (handleDiscoInfoGet(stanza, ctx)) return;
    if (handleDiscoItemsGet(stanza, ctx)) return;
    if (handlePingGet(stanza, ctx)) return;
    return;
  }

  if (!stanza.is('message')) return;

  // XEP-0313: antes del filtro chat/groupchat, son wrappers sin type ni body propio.
  if (isMamResult(stanza)) {
    await handleMamResult(stanza, ctx);
    return;
  }

  // XEP-0353: llamada entrante / respuesta. Va ANTES del filtro carbon: los
  // jingle-messages de NUESTRA cuenta (carbons de proceed/reject/finish de
  // otro dispositivo) sincronizan el estado local; el handler sólo mira
  // jingle-message como hijo directo, así que un carbon con <forwarded>
  // de un peer no matchea y cae al filtro carbon de abajo.
  if (await handleJingleMessage(stanza, ctx)) return;

  // XEP-0280: los carbons de NUESTRAS propias llamadas no deben disparar la
  // lógica Jingle (el echo de un propose saliente dispararía un reject auto).
  if (isCarbon(stanza)) {
    // XEP-0280 §6: un carbon que no viene de nuestra propia cuenta es una suplantación.
    if (bareJid((stanza.attrs.from as string) ?? '') === bareJid(ctx.config.jid)) await handleCarbon(stanza, ctx);
    return;
  }

  // Invitaciones y asunto de sala (no son chat/groupchat con cuerpo).
  if (handleMucMessage(stanza)) return;

  await handleChatMessage(stanza, ctx);
}
