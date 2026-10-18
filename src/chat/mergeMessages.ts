import type { XmppMessage } from '@/types/xmpp';

/** Same message, seen twice: once live, once replayed from the archive. */
const DEDUPE_WINDOW_MS = 30_000;

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
 * Devuelve los MISMOS objetos que recibió (nunca copias): la identidad estable
 * es lo que deja a la lista saltarse las filas que no cambiaron.
 */
export function mergeMessages(...lists: (readonly XmppMessage[])[]): XmppMessage[] {
  const merged: { msg: XmppMessage; time: number }[] = [];
  const seenIds = new Set<string>();
  // direction+body -> tiempos ya aceptados: dedupe O(n) en vez de O(n²).
  const byContent = new Map<string, number[]>();

  for (const list of lists) {
    for (const msg of list) {
      if (seenIds.has(msg.id)) continue;
      const time = Date.parse(msg.timestamp);
      const key = `${msg.direction}\0${msg.body}`;
      const times = byContent.get(key);
      if (times?.some((t) => Math.abs(t - time) <= DEDUPE_WINDOW_MS)) continue;
      seenIds.add(msg.id);
      if (times) times.push(time);
      else byContent.set(key, [time]);
      merged.push({ msg, time });
    }
  }

  return merged.sort((a, b) => b.time - a.time).map((e) => e.msg);
}
