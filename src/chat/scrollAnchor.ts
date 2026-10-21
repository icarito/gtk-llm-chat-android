/**
 * Decisión de anclaje de scroll para la lista de mensajes.
 *
 * La lista NO es invertida: el mensaje más nuevo es el último, así que "el
 * final" es donde queremos aterrizar al entrar. Guardamos la posición por
 * conversación para volver donde el usuario estaba, pero descartando offsets
 * capturados mientras la lista aún no tenía contenido medido (eso hacía que
 * abriera "por cualquier lado").
 */
export type ScrollMemoryEntry = {
  /** Desplazamiento vertical observado. */
  offset: number;
  /** Alto del contenido cuando se guardó. */
  contentHeight: number;
  /** Alto del viewport cuando se guardó. */
  viewportHeight: number;
  /** ¿Estaba pegado al final? */
  atBottom: boolean;
};

export type ScrollAnchor =
  | { kind: 'bottom' }
  | { kind: 'offset'; offset: number };

/** Margen para considerar "al final" (px). */
export const AT_BOTTOM_EPSILON = 8;

/**
 * ¿La lista está pegada al final? Con contenido más corto que el viewport
 * siempre lo está.
 */
export function isAtBottom(offset: number, contentHeight: number, viewportHeight: number): boolean {
  if (contentHeight <= viewportHeight + 1) return true;
  return contentHeight - offset - viewportHeight <= AT_BOTTOM_EPSILON;
}

/**
 * Resuelve el destino del anclaje con la altura de contenido ACTUAL.
 *
 * - Sin memoria (primera vez en la sesión) o si estaba al final → al final.
 * - Si había subido, se restaura el offset SÓLO si cabe en el contenido actual;
 *   si no (la lista encogió, o el offset era de un layout incompleto) se cae a
 *   "al final" en vez de saltar a un hueco vacío.
 */
export function decideScrollAnchor(
  saved: ScrollMemoryEntry | undefined,
  currentContentHeight: number,
): ScrollAnchor {
  if (!saved || saved.atBottom) return { kind: 'bottom' };
  if (currentContentHeight <= 0) return { kind: 'bottom' };
  const maxOffset = Math.max(0, currentContentHeight - saved.viewportHeight);
  if (saved.offset < 0 || saved.offset > maxOffset + 1) return { kind: 'bottom' };
  // Un offset ~0 con contenido más alto que el viewport es "el tope": igual es
  // una posición válida (el usuario estaba arriba del todo), así que se respeta.
  return { kind: 'offset', offset: saved.offset };
}
