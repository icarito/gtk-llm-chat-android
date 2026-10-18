// Adjuntos cifrados de OMEMO Media Sharing (XEP-0454): AES-256-GCM con clave
// e IV aleatorios. El ciphertext subido incluye el tag GCM al final; la URL
// `aesgcm://host/path#<hex(iv)><hex(key)>` viaja como cuerpo del mensaje
// OMEMO 2, nunca como OOB en claro. Núcleo puro: sin fetch ni filesystem.
import { gcm } from '@noble/ciphers/aes';
import { bytesToHex, hexToBytes } from './bytes';

export const AESGCM_SCHEME = 'aesgcm://';
export const MEDIA_KEY_BYTES = 32;
export const MEDIA_IV_BYTES = 12;
const FRAGMENT_HEX = (MEDIA_IV_BYTES + MEDIA_KEY_BYTES) * 2; // iv primero, luego key

export interface EncryptedMedia {
  /** ciphertext || tag (16 bytes). */
  ciphertext: Uint8Array;
  iv: Uint8Array;
  key: Uint8Array;
}

export interface ParsedAesgcmUrl {
  /** URL https de descarga (sin fragmento). */
  downloadUrl: string;
  iv: Uint8Array;
  key: Uint8Array;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** `key`/`iv` sólo para vectores de prueba; en producción se generan al azar. */
export function encryptMedia(
  plaintext: Uint8Array,
  opts: { key?: Uint8Array; iv?: Uint8Array } = {},
): EncryptedMedia {
  const key = opts.key ?? randomBytes(MEDIA_KEY_BYTES);
  const iv = opts.iv ?? randomBytes(MEDIA_IV_BYTES);
  if (key.length !== MEDIA_KEY_BYTES) throw new Error('omemo2: clave AES-GCM inválida');
  if (iv.length !== MEDIA_IV_BYTES) throw new Error('omemo2: IV AES-GCM inválido');
  return { ciphertext: gcm(key, iv).encrypt(plaintext), iv, key };
}

/** Lanza si el tag GCM no verifica (ciphertext corrupto o clave/IV equivocados). */
export function decryptMedia(ciphertext: Uint8Array, iv: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== MEDIA_KEY_BYTES) throw new Error('omemo2: clave AES-GCM inválida');
  if (iv.length !== MEDIA_IV_BYTES) throw new Error('omemo2: IV AES-GCM inválido');
  if (ciphertext.length < 16) throw new Error('omemo2: ciphertext AES-GCM truncado');
  return gcm(key, iv).decrypt(ciphertext);
}

/** Sustituye el esquema de la URL de descarga por `aesgcm://` y añade iv+key. */
export function buildAesgcmUrl(getUrl: string, key: Uint8Array, iv: Uint8Array): string {
  if (key.length !== MEDIA_KEY_BYTES || iv.length !== MEDIA_IV_BYTES) {
    throw new Error('omemo2: clave/IV inválidos para la URL aesgcm');
  }
  const rest = getUrl.replace(/^https?:\/\//i, '');
  return `${AESGCM_SCHEME}${rest}#${bytesToHex(iv)}${bytesToHex(key)}`;
}

/** Null si no es una URL aesgcm válida (esquema, longitudes o hex inválido). */
export function parseAesgcmUrl(url: string): ParsedAesgcmUrl | null {
  if (!url.startsWith(AESGCM_SCHEME)) return null;
  const hash = url.lastIndexOf('#');
  if (hash <= AESGCM_SCHEME.length) return null;
  const fragment = url.slice(hash + 1);
  if (!new RegExp(`^[0-9a-fA-F]{${FRAGMENT_HEX}}$`).test(fragment)) return null;
  try {
    const iv = hexToBytes(fragment.slice(0, MEDIA_IV_BYTES * 2));
    const key = hexToBytes(fragment.slice(MEDIA_IV_BYTES * 2));
    const rest = url.slice(AESGCM_SCHEME.length, hash);
    return { downloadUrl: `https://${rest}`, iv, key };
  } catch {
    return null;
  }
}
