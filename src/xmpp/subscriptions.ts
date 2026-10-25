import { useSyncExternalStore } from 'react';

export interface SubscriptionRequest {
  bare: string;
  /** JID completo del que pide. */
  from: string;
  timestamp: number;
}

let requests: readonly SubscriptionRequest[] = Object.freeze([]);
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Store observable de solicitudes de suscripción (presence type=subscribe) pendientes. */
export const subscriptions = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  getSnapshot(): readonly SubscriptionRequest[] {
    return requests;
  },
  upsert(req: SubscriptionRequest) {
    const next = requests.filter((r) => r.bare !== req.bare);
    requests = Object.freeze([...next, req]);
    emit();
  },
  remove(bare: string) {
    const next = requests.filter((r) => r.bare !== bare);
    if (next.length === requests.length) return;
    requests = Object.freeze(next);
    emit();
  },
  reset() {
    requests = Object.freeze([]);
    emit();
  },
};

export function useSubscriptionRequests(): readonly SubscriptionRequest[] {
  return useSyncExternalStore(subscriptions.subscribe, subscriptions.getSnapshot);
}
