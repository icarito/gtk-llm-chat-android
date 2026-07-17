import AsyncStorage from '@react-native-async-storage/async-storage';

const DEVICE_SUFFIX_KEY = '@gtk_llm_chat:device_resource_suffix';

let cached: string | null = null;

/**
 * Sufijo de recurso XMPP estable para este dispositivo.
 *
 * El recurso llevaba un sufijo aleatorio NUEVO en cada arranque
 * ("gtk-llm-chat-android-a1b2c3d4"), así que el servidor no podía reconocer la
 * sesión anterior como nuestra: en vez de reemplazarla la dejaba viva, y cada
 * reconexión sumaba una sesión zombi (llegamos a ver 317 en Prosody). Cada
 * zombi sigue recibiendo carbons y disparando notificaciones push.
 *
 * Con un sufijo persistido, reconectar reemplaza limpiamente la sesión previa,
 * y el sufijo sigue permitiendo tener a la vez este teléfono y el cliente de
 * escritorio conectados con la misma cuenta.
 */
export async function getDeviceResourceSuffix(): Promise<string> {
  if (cached) return cached;
  try {
    const stored = await AsyncStorage.getItem(DEVICE_SUFFIX_KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch {
    // Sin almacenamiento nos toca uno efímero: mejor eso que no conectar.
  }
  const generated = Math.random().toString(36).slice(2, 10);
  cached = generated;
  try {
    await AsyncStorage.setItem(DEVICE_SUFFIX_KEY, generated);
  } catch {
    // Igual que arriba: no es fatal, sólo perdemos la estabilidad.
  }
  return generated;
}
