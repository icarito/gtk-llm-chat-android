// Descarga y descifra un adjunto XEP-0454 al cache local. El cuerpo cifrado
// llega como URL aesgcm:// dentro del mensaje OMEMO 2; aquí se pide su versión
// https, se descifra y se deja en disco para que la UI pueda mostrarla.
import * as FileSystem from 'expo-file-system/legacy';
import { b64encode, bytesToHex, decryptMedia, parseAesgcmUrl } from '@/omemo2';

const CACHE_DIR = 'aesgcm/';

function cachePath(iv: Uint8Array, key: Uint8Array): string | null {
  if (!FileSystem.cacheDirectory) return null;
  return `${FileSystem.cacheDirectory}${CACHE_DIR}${bytesToHex(iv)}${bytesToHex(key)}.bin`;
}

async function writeCache(path: string, plaintext: Uint8Array): Promise<void> {
  await FileSystem.makeDirectoryAsync(`${FileSystem.cacheDirectory}${CACHE_DIR}`, { intermediates: true })
    .catch(() => {});
  await FileSystem.writeAsStringAsync(path, b64encode(plaintext), {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/** Deja en cache el claro de un adjunto que enviamos, para mostrarlo sin re-descargar. */
export async function cacheSentMedia(iv: Uint8Array, key: Uint8Array, plaintext: Uint8Array): Promise<string | null> {
  const path = cachePath(iv, key);
  if (!path) return null;
  try {
    await writeCache(path, plaintext);
    return path;
  } catch {
    return null;
  }
}

/** URI local del adjunto, o null si `body` no es una URL aesgcm válida. */
export async function materializeAesgcm(body: string): Promise<string | null> {
  const parsed = parseAesgcmUrl(body.trim());
  const path = parsed && cachePath(parsed.iv, parsed.key);
  if (!parsed || !path) return null;
  try {
    const cached = await FileSystem.getInfoAsync(path);
    if (cached.exists) return path;
    const response = await fetch(parsed.downloadUrl);
    if (!response.ok) return null;
    const ciphertext = new Uint8Array(await response.arrayBuffer());
    const plaintext = decryptMedia(ciphertext, parsed.iv, parsed.key);
    await writeCache(path, plaintext);
    return path;
  } catch {
    // Un adjunto que no se puede bajar/descifrar no debe tumbar el mensaje.
    return null;
  }
}
