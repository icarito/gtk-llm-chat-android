import { invoke } from '@tauri-apps/api/core';

// Preserve the mobile contract: the database key belongs in the OS keyring,
// never beside the encrypted SQLite values or in webview localStorage.
export async function getItemAsync(key: string): Promise<string | null> {
  if (key !== 'omemo2_db_key') throw new Error('Unsupported desktop secret');
  return invoke<string | null>('omemo_key_get');
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  if (key !== 'omemo2_db_key') throw new Error('Unsupported desktop secret');
  await invoke('omemo_key_set', { value });
}
