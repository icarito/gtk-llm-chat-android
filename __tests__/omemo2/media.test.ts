import 'react-native-get-random-values';
import {
  AESGCM_SCHEME,
  MEDIA_IV_BYTES,
  MEDIA_KEY_BYTES,
  buildAesgcmUrl,
  decryptMedia,
  encryptMedia,
  parseAesgcmUrl,
} from '@/omemo2';

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * seed + 7) & 0xff);

describe('XEP-0454: cifrado de adjuntos', () => {
  test('round-trip AES-256-GCM con clave/IV aleatorios', () => {
    const plaintext = utf8('adjunto confidencial, ñ y emoji 🔒');
    const enc = encryptMedia(plaintext);
    expect(enc.key).toHaveLength(MEDIA_KEY_BYTES);
    expect(enc.iv).toHaveLength(MEDIA_IV_BYTES);
    expect(enc.ciphertext).toHaveLength(plaintext.length + 16); // tag GCM
    expect(text(decryptMedia(enc.ciphertext, enc.iv, enc.key))).toBe(text(plaintext));
  });

  test('clave/IV inyectables (vector determinista) y ciphertext distinto entre IVs', () => {
    const key = bytes(32);
    const iv1 = bytes(12, 3);
    const iv2 = bytes(12, 5);
    const a = encryptMedia(utf8('hola'), { key, iv: iv1 });
    const b = encryptMedia(utf8('hola'), { key, iv: iv2 });
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(text(decryptMedia(a.ciphertext, iv1, key))).toBe('hola');
  });

  test('un tag inválido o un ciphertext manipulado lanza', () => {
    const enc = encryptMedia(utf8('no tocar'));
    const tampered = enc.ciphertext.slice();
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decryptMedia(tampered, enc.iv, enc.key)).toThrow();
    expect(() => decryptMedia(enc.ciphertext, enc.iv, bytes(32, 9))).toThrow();
    expect(() => decryptMedia(enc.ciphertext.slice(0, 15), enc.iv, enc.key)).toThrow(/truncado/);
  });

  test('la URL aesgcm lleva iv+key en el fragmento y se puede parsear', () => {
    const key = bytes(32);
    const iv = bytes(12, 2);
    const url = buildAesgcmUrl('https://upload.x.org/abc/def.bin?x=1', key, iv);
    expect(url.startsWith(AESGCM_SCHEME)).toBe(true);
    expect(url).not.toContain('https://');
    const parsed = parseAesgcmUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.downloadUrl).toBe('https://upload.x.org/abc/def.bin?x=1');
    expect(parsed!.iv).toEqual(iv);
    expect(parsed!.key).toEqual(key);
  });

  test('parseAesgcmUrl rechaza esquema, longitudes y hex inválidos', () => {
    const fragment = 'ab'.repeat(MEDIA_IV_BYTES + MEDIA_KEY_BYTES);
    expect(parseAesgcmUrl(`https://h/p#${fragment}`)).toBeNull();
    expect(parseAesgcmUrl(`${AESGCM_SCHEME}h/p`)).toBeNull();
    expect(parseAesgcmUrl(`${AESGCM_SCHEME}h/p#${fragment.slice(2)}`)).toBeNull();
    expect(parseAesgcmUrl(`${AESGCM_SCHEME}h/p#${'zz'.repeat(44)}`)).toBeNull();
    expect(parseAesgcmUrl(`${AESGCM_SCHEME}h/p#${fragment}`)).not.toBeNull();
  });
});
