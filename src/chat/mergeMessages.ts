import type { XmppMessage } from '@/types/xmpp';

/** Same message, seen twice: once live, once replayed from the archive. */
const DEDUPE_WINDOW_MS = 30_000;

/**
 * ¿Es el cuerpo placeholder de un cifrado que no se pudo descifrar? Lo emite
 * `decrypt.ts` con el prefijo `🔒 [`. Sirve para que un refetch en frío (motor
 * OMEMO 2 aún sin inicializar) no reemplace un mensaje ya descifrado por su
 * versión bloqueada.
 */
export function isUndecryptableBody(body: string): boolean {
  return /^🔒\s*\[/.test(body.trim());
}

/**
 * Une listas de mensajes en una conversación cronológica sin duplicados,
 * NEWEST FIRST (orden de una lista invertida).
 *
 * Los ids no bastan: un mensaje enviado en vivo lleva nuestro id local y el
 * archivo lo devuelve con el suyo. Dos mensajes coinciden si tienen el mismo
 * texto y dirección dentro de una ventana corta (como attach_mam_to_recent_message
 * en el cliente GTK). En empate gana la primera lista: pasar primero la fuente
 * más fresca (el store en vivo), que es la que recibe correcciones y reacciones.
 *
 * Además, un mismo mensaje puede aparecer descifrado y como placeholder
 * bloqueado (misma dirección/remitente/timestamp): en ese caso gana el
 * descifrado y el placeholder se descarta, para que la lista no "retroceda" a
 * mostrar sin descifrar lo que ya estaba legible.
 *
 * Devuelve los MISMOS objetos que recibió (nunca copias): la identidad estable
 * es lo que deja a la lista saltarse las filas que no cambiaron.
 */
export function mergeMessages(...lists: (readonly XmppMessage[])[]): XmppMessage[] {
  const merged: { msg: XmppMessage; time: number }[] = [];
  const seenIds = new Set<string>();
  // direction+body -> tiempos ya aceptados: dedupe O(n) en vez de O(n²).
  const byContent = new Map<string, number[]>();
  // direction+from+timestamp -> índice en `merged`: identifica el mismo mensaje
  // lógico para preferir la versión descifrada sobre el placeholder.
  const bySlot = new Map<string, number>();

  for (const list of lists) {
    for (const msg of list) {
      if (seenIds.has(msg.id)) continue;
      const time = Date.parse(msg.timestamp);

      const slot = `${msg.direction}\0${msg.from}\0${msg.timestamp}`;
      const slotIdx = bySlot.get(slot);
      if (slotIdx !== undefined) {
        const prev = merged[slotIdx]!.msg;
        const prevLocked = isUndecryptableBody(prev.body);
        const nextLocked = isUndecryptableBody(msg.body);
        if (prevLocked !== nextLocked) {
          // Uno está descifrado y el otro no: conservar SIEMPRE el descifrado.
          if (!nextLocked) {
            merged[slotIdx] = { msg, time };
            seenIds.add(msg.id);
          }
          continue;
        }
      }

      const key = `${msg.direction}\0${msg.body}`;
      const times = byContent.get(key);
      if (times?.some((t) => Math.abs(t - time) <= DEDUPE_WINDOW_MS)) continue;
      seenIds.add(msg.id);
      if (times) times.push(time);
      else byContent.set(key, [time]);
      if (!bySlot.has(slot)) bySlot.set(slot, merged.length);
      merged.push({ msg, time });
    }
  }

  return merged.sort((a, b) => b.time - a.time).map((e) => e.msg);
}
