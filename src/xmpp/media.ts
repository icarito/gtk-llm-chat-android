// Descarga y descifra un adjunto XEP-0454 al cache local. El cuerpo cifrado
// llega como URL aesgcm:// dentro del mensaje OMEMO 2; aquí se pide su versión
// https, se descifra y se deja en disco para que la UI pueda mostrarla.
import * as FileSystem from 'expo-file-system/legacy';
import { b64encode, bytesToHex, decryptMedia, parseAesgcmUrl } from '@/omemo2';

const CACHE_DIR = 'aesgcm/';

/** URI local del adjunto, o null si `body` no es una URL aesgcm válida. */
export async function materializeAesgcm(body: string): Promise<string | null> {
  const parsed = parseAesgcmUrl(body.trim());
  if (!parsed || !FileSystem.cacheDirectory) return null;
  const dir = `${FileSystem.cacheDirectory}${CACHE_DIR}`;
  const path = `${dir}${bytesToHex(parsed.iv)}${bytesToHex(parsed.key)}.bin`;
  try {
    const cached = await FileSystem.getInfoAsync(path);
    if (cached.exists) return path;
    const response = await fetch(parsed.downloadUrl);
    if (!response.ok) return null;
    const ciphertext = new Uint8Array(await response.arrayBuffer());
    const plaintext = decryptMedia(ciphertext, parsed.iv, parsed.key);
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    await FileSystem.writeAsStringAsync(path, b64encode(plaintext), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return path;
  } catch {
    // Un adjunto que no se puede bajar/descifrar no debe tumbar el mensaje.
    return null;
  }
}
