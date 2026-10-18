import AsyncStorage from '@react-native-async-storage/async-storage';

/** Preferencia persistida: foreground service de Android (default true). */
const FOREGROUND_SERVICE_KEY = 'xmpp.foregroundService';

export async function getForegroundServiceEnabled(): Promise<boolean> {
  const stored = await AsyncStorage.getItem(FOREGROUND_SERVICE_KEY);
  return stored === null ? true : stored !== 'false';
}

export async function setForegroundServiceEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(FOREGROUND_SERVICE_KEY, enabled ? 'true' : 'false');
}
