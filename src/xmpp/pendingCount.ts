import type { XmppMessage } from '@/types/xmpp';

/**
 * Cuántos mensajes le mandaste al agente que todavía no ha contestado.
 *
 * Es un estado puramente local y optimista: se enciende en cuanto envías, sin
 * esperar a que el servidor publique presencia. Cubre el hueco entre "envié
 * algo" y "el agente arrancó y publicó dnd" — que puede ser de varios segundos
 * y hasta ahora se veía como si no hubiera pasado nada.
 *
 * Cuenta los mensajes salientes desde la última respuesta entrante: si su
 * último mensaje es tuyo, todo lo que mandaste después está sin atender.
 */
export function pendingOutboundCount(messages: XmppMessage[]): number {
  let pending = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.direction === 'in') break;
    pending++;
  }
  return pending;
}
