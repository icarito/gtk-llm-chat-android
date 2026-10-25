import { useSyncExternalStore } from 'react';

export type CallDirection = 'incoming' | 'outgoing';
export type CallPhase = 'ringing' | 'connecting' | 'active' | 'ended' | 'failed';

export interface CallState {
  sid: string;
  /** JID completo del peer. */
  peer: string;
  direction: CallDirection;
  phase: CallPhase;
  media: 'audio';
  stream?: unknown;
}

let current: CallState | null = null;
const listeners = new Set<() => void>();

/** Store observable de la llamada activa (fase 1: una sola a la vez). */
export const calls = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  getSnapshot(): CallState | null {
    return current;
  },
  set(state: CallState | null) {
    current = state;
    for (const listener of listeners) listener();
  },
};

export function useActiveCall(): CallState | null {
  return useSyncExternalStore(calls.subscribe, calls.getSnapshot);
}
