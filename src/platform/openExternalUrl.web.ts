import { Linking } from 'react-native';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    await openUrl(url);
  } else {
    await Linking.openURL(url);
  }
}
