import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

const MUTED_JIDS_KEY = '@gtk_llm_chat:muted_jids';

let cached: Set<string> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

function ensureLoaded(): Promise<void> {
  if (cached) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      try {
        const raw = await AsyncStorage.getItem(MUTED_JIDS_KEY);
        cached = new Set(raw ? (JSON.parse(raw) as string[]) : []);
      } catch {
        cached = new Set();
      }
      notifyListeners();
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

async function persist(): Promise<void> {
  await ensureLoaded();
  await AsyncStorage.setItem(MUTED_JIDS_KEY, JSON.stringify([...cached!]));
}

export async function getMutedJids(): Promise<Set<string>> {
  await ensureLoaded();
  return cached!;
}

export async function isMuted(bare: string): Promise<boolean> {
  const set = await getMutedJids();
  return set.has(bare);
}

export async function toggleMuted(bare: string): Promise<boolean> {
  const set = await getMutedJids();
  const next = !set.has(bare);
  const updated = new Set(set);
  if (next) updated.add(bare);
  else updated.delete(bare);
  cached = updated;
  await persist();
  notifyListeners();
  return next;
}

export function subscribeMuted(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY = new Set<string>();

export function getMutedSnapshot(): ReadonlySet<string> {
  return cached ?? EMPTY;
}

export function useMuted(bare: string): boolean {
  useSyncExternalStore(subscribeMuted, getMutedSnapshot);
  return cached?.has(bare) ?? false;
}
