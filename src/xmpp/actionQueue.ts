/**
 * Cola en memoria de respuestas a acciones pendientes que llegaron por
 * notificación cuando la conexión XMPP no estaba disponible (app cerrada o
 * en reconexión). Se vacía sola al pasar a online, desde el observador de
 * estado de XmppService.
 *
 * Deduplica por id de acción: el usuario puede tocar el mismo botón varias
 * veces mientras la app arranca y la acción debe salir una sola vez.
 */
export type ActionQueueRunner = (actionId: string) => Promise<void>;

const queued = new Set<string>();
let runner: ActionQueueRunner | null = null;

export function setActionQueueRunner(fn: ActionQueueRunner | null): void {
  runner = fn;
}

/** Encola una respuesta. Devuelve false si ya estaba encolada. */
export function enqueueActionResponse(actionId: string): boolean {
  if (queued.has(actionId)) return false;
  queued.add(actionId);
  return true;
}

export function getQueuedActionResponses(): string[] {
  return [...queued];
}

export function clearActionQueue(): void {
  queued.clear();
}

/**
 * Ejecuta en orden todo lo encolado. Si una respuesta falla se vuelve a
 * encolar para el próximo paso a online; la acción sigue pendiente en el
 * servidor, así que reintentarla es seguro.
 */
export async function flushQueuedActionResponses(): Promise<void> {
  if (!runner || queued.size === 0) return;
  const pending = [...queued];
  queued.clear();
  for (const actionId of pending) {
    try {
      await runner(actionId);
    } catch {
      if (!queued.has(actionId)) queued.add(actionId);
    }
  }
}
