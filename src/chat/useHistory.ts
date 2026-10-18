import { useCallback, useEffect, useRef, useState } from 'react';
import type { XmppMessage } from '@/types/xmpp';
import { XmppService } from '@/xmpp/XmppService';
import { mergeMessages } from './mergeMessages';

/** How much of the conversation to show on open. The rest stays one tap away. */
const INITIAL_PAGE_SIZE = 30;
const OLDER_PAGE_SIZE = 30;

function runWhenIdle(task: () => void): () => void {
  const idle = (
    globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    }
  );
  if (idle.requestIdleCallback) {
    const handle = idle.requestIdleCallback(task);
    return () => idle.cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(task, 0);
  return () => clearTimeout(handle);
}

function oldestOf(list: readonly XmppMessage[]): string | null {
  let oldest: XmppMessage | null = null;
  for (const m of list) {
    if (!oldest || Date.parse(m.timestamp) < Date.parse(oldest.timestamp)) oldest = m;
  }
  return oldest?.timestamp ?? null;
}

/**
 * Historial de una conversación: caché local al abrir, MAM en segundo plano y
 * paginación hacia atrás. Los mensajes en vivo NO pasan por aquí (los trae
 * useConversation); esto es sólo lo que el store en vivo aún no tiene.
 *
 * `syncTick` re-dispara el catch-up de MAM (volver a enfocar la pantalla) sin
 * vaciar la lista visible.
 */
export function useHistory(jid: string, online: boolean, syncTick: number) {
  const [history, setHistory] = useState<readonly XmppMessage[]>([]);
  const [rehydrating, setRehydrating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const hasCachedRef = useRef(false);
  // Evita que loadOlder dependa de `history` (y cambie de identidad en cada
  // página): la lista pasa este callback a todas las filas.
  const oldestRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const exhaustedRef = useRef(false);

  const set = useCallback((next: readonly XmppMessage[]) => {
    oldestRef.current = oldestOf(next);
    setHistory(next);
  }, []);

  // Paint the cache immediately on open, then catch up with the archive.
  // Depende sólo de `jid`: recuperar foco no debe vaciar la lista.
  useEffect(() => {
    let cancelled = false;
    let cancelIdle: (() => void) | null = null;
    hasCachedRef.current = false;
    exhaustedRef.current = false;
    busyRef.current = false;
    set([]);
    setExhausted(false);
    setRehydrating(true);

    (async () => {
      try {
        const cached = await XmppService.loadCachedHistory(jid, INITIAL_PAGE_SIZE, { restoreActions: false });
        if (cancelled) return;
        hasCachedRef.current = cached.length > 0;
        set(cached);
        cancelIdle = runWhenIdle(() => {
          XmppService.restoreCachedActions(jid, INITIAL_PAGE_SIZE)
            .finally(() => { if (!cancelled) setRehydrating(false); });
        });
      } catch (error) {
        // Sin esto, un fallo (p.ej. el SQLite no abrió) deja la pantalla en
        // blanco sin rastro.
        console.warn('[xmpp-chat] loadCachedHistory failed', error);
      } finally {
        if (!cancelled && cancelIdle === null) setRehydrating(false);
      }
    })();

    return () => { cancelled = true; cancelIdle?.(); };
  }, [jid, set]);

  // Sin caché el sync es visible; con caché se refresca en silencio al quedar libre.
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    let cancelIdle: (() => void) | null = null;
    const showSync = !hasCachedRef.current;
    if (showSync) setSyncing(true);

    const runSync = async () => {
      try {
        await XmppService.syncHistory(jid);
        if (cancelled) return;
        const recent = await XmppService.loadCachedHistory(jid, INITIAL_PAGE_SIZE, { restoreActions: false });
        if (cancelled) return;
        hasCachedRef.current = recent.length > 0;
        // Si el usuario ya paginó más atrás, se une; si no, se reemplaza.
        setHistory((prev) => {
          const next = prev.length > recent.length ? mergeMessages(prev, recent) : recent;
          oldestRef.current = oldestOf(next);
          return next;
        });
      } catch (error) {
        console.warn('[xmpp-chat] syncHistory failed', error);
      } finally {
        if (!cancelled) setSyncing(false);
      }
    };

    if (showSync) runSync();
    else cancelIdle = runWhenIdle(() => { runSync(); });

    return () => { cancelled = true; cancelIdle?.(); };
  }, [jid, online, syncTick]);

  const loadOlder = useCallback(async () => {
    if (busyRef.current || exhaustedRef.current || oldestRef.current === null) return;
    busyRef.current = true;
    setLoadingOlder(true);
    try {
      const older = await XmppService.loadOlderHistory(jid, oldestRef.current, OLDER_PAGE_SIZE);
      if (older.length === 0) {
        exhaustedRef.current = true;
        setExhausted(true);
        return;
      }
      setHistory((prev) => {
        const next = mergeMessages(prev, older);
        oldestRef.current = oldestOf(next);
        return next;
      });
    } finally {
      busyRef.current = false;
      setLoadingOlder(false);
    }
  }, [jid]);

  return { history, rehydrating, syncing, loadingOlder, exhausted, loadOlder };
}
