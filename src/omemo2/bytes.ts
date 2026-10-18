// Utilidades de bytes compartidas por el núcleo OMEMO 2.
import { concatBytes, hexToBytes, bytesToHex, randomBytes } from '@noble/hashes/utils';

export { concatBytes, hexToBytes, bytesToHex, randomBytes };

// Comparación en tiempo constante.
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
