import { useCallback, useSyncExternalStore } from 'react';
import { connection } from '@/xmpp/session';
import { contacts, pendingActions, unread } from '@/xmpp/store';
import { XmppService } from '@/xmpp/XmppService';
import type { XmppConnectionState, XmppContact, XmppPendingAction } from '@/types/xmpp';

// Selectores finos sobre los stores: la pantalla NO usa useXmpp(), cuyo value
// cambia con cualquier mensaje o contacto de cualquier conversación.

const subscribeConnection = (cb: () => void) => connection.subscribe(cb);

/** Estado de conexión; re-renderiza sólo cuando el valor cambia. */
export function useConnectionState(): XmppConnectionState {
  return useSyncExternalStore(subscribeConnection, () => connection.legacyState());
}

export function useContact(jid: string): XmppContact | undefined {
  return useSyncExternalStore(contacts.subscribe, () => contacts.get(jid));
}

/** Snapshot estable (cambia sólo al publicarse un cambio); filtrar con useMemo. */
export function usePendingActions(): readonly XmppPendingAction[] {
  return useSyncExternalStore(
    useCallback((cb: () => void) => pendingActions.subscribe(cb), []),
    () => pendingActions.getAll(),
  );
}

/** XEP-0085: ¿está el contacto "escribiendo…"? */
export function usePeerTyping(jid: string): boolean {
  return useSyncExternalStore(
    useCallback((cb: () => void) => {
      const off = XmppService.onTypingChange((changed) => { if (changed === jid) cb(); });
      return () => { off(); };
    }, [jid]),
    () => XmppService.isTyping(jid),
  );
}

/** No leídos de una conversación; re-renderiza sólo cuando cambian. */
export function useUnread(jid: string): number {
  return useSyncExternalStore(
    useCallback((cb: () => void) => unread.subscribe(cb), []),
    () => unread.get(jid),
  );
}

/** Total de no leídos (para badges de pestañas). */
export function useUnreadTotal(): number {
  return useSyncExternalStore(
    useCallback((cb: () => void) => unread.subscribe(cb), []),
    () => unread.total(),
  );
}

/** Nuestro nick en la sala `jid`; `null` si no es una sala. Primitivo: no re-renderiza por presencia de otros. */
export function useRoomNick(jid: string): string | null {
  return useSyncExternalStore(
    XmppService.rooms.subscribe,
    () => XmppService.rooms.get(jid)?.nick ?? null,
  );
}
