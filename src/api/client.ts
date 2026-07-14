import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Conversation, Message, ModelInfo, ServerStatus } from '@/types';

const BASE_KEY = '@gtk_llm_chat:server_base';
const DEFAULT_BASE = 'http://127.0.0.1:8765';

let cachedBase: string | null = null;

async function getBase(): Promise<string> {
  if (cachedBase) return cachedBase;
  const stored = await AsyncStorage.getItem(BASE_KEY);
  cachedBase = stored || DEFAULT_BASE;
  return cachedBase;
}

export async function setServerBase(base: string): Promise<void> {
  cachedBase = base;
  await AsyncStorage.setItem(BASE_KEY, base);
}

export function getServerBaseSync(): string {
  return cachedBase || DEFAULT_BASE;
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = await getBase();
  const url = `${base}${path}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchHealth(): Promise<ServerStatus> {
  return apiFetch<ServerStatus>('/health');
}

export async function fetchModels(): Promise<ModelInfo[]> {
  return apiFetch<ModelInfo[]>('/models');
}

export async function fetchConversations(
  limit = 50,
  offset = 0,
): Promise<Conversation[]> {
  return apiFetch<Conversation[]>(`/conversations?limit=${limit}&offset=${offset}`);
}

export async function fetchConversationHistory(cid: string): Promise<Message[]> {
  return apiFetch<Message[]>(`/conversations/${cid}/history`);
}

export async function createConversation(
  name: string,
  model?: string,
): Promise<Conversation> {
  return apiFetch<Conversation>('/conversations', {
    method: 'POST',
    body: JSON.stringify({ name, model }),
  });
}

export async function deleteConversation(cid: string): Promise<void> {
  await apiFetch(`/conversations/${cid}`, { method: 'DELETE' });
}

export async function renameConversation(cid: string, title: string): Promise<void> {
  await apiFetch(`/conversations/${cid}/title`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  });
}

export function buildWebSocketUrl(cid: string): string {
  const base = getServerBaseSync().replace(/^http/, 'ws');
  return `${base}/conversations/${cid}/stream`;
}
