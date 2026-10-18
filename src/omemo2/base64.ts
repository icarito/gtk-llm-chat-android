// Base64 estándar sin depender de atob/btoa (disponibles en Hermes, no garantizados en todos los entornos).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64encode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < b.length ? ALPHABET[(n >> 6) & 63] : '=';
    out += i + 2 < b.length ? ALPHABET[n & 63] : '=';
  }
  return out;
}

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '').replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('omemo2: base64 inválido');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}
