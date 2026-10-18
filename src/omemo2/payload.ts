// Capa de payload de OMEMO 2: SCE (XEP-0420) cifrado con AES-256-CBC + HMAC-SHA-256
// truncado a 16 bytes. <payload> lleva sólo el ciphertext; la clave de 32 bytes
// y el tag (48 bytes en total) viajan por dispositivo dentro del ratchet.
import { cbc } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, ctEqual, fromUtf8, randomBytes, utf8 } from './bytes';

const INFO = utf8('OMEMO Payload');
const NS_SCE = 'urn:xmpp:sce:1';
const NS_CLIENT = 'jabber:client';

function derive(key: Uint8Array) {
  const okm = hkdf(sha256, key, new Uint8Array(32), INFO, 80);
  return { enc: okm.subarray(0, 32), auth: okm.subarray(32, 64), iv: okm.subarray(64, 80) };
}

// `key` (32) sólo para vectores de prueba.
export function encryptPayload(plaintext: Uint8Array, key: Uint8Array = randomBytes(32)) {
  const k = derive(key);
  const payload = cbc(k.enc, k.iv).encrypt(plaintext);
  const keyMaterial = concatBytes(key, hmac(sha256, k.auth, payload).subarray(0, 16));
  return { payload, keyMaterial };
}

export function decryptPayload(payload: Uint8Array, keyMaterial: Uint8Array): Uint8Array {
  if (keyMaterial.length !== 48 || payload.length === 0) throw new Error('omemo2: payload o clave inválidos');
  const k = derive(keyMaterial.subarray(0, 32));
  if (!ctEqual(keyMaterial.subarray(32), hmac(sha256, k.auth, payload).subarray(0, 16))) {
    throw new Error('omemo2: HMAC del payload inválido');
  }
  return cbc(k.enc, k.iv).decrypt(payload);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// <envelope> SCE con body. `rpad` fijo sólo para tests; si no, 0..200 letras al azar.
export function buildEnvelope(body: string, opts: { to?: string; from?: string; rpad?: string } = {}): Uint8Array {
  let rpad = opts.rpad;
  if (rpad === undefined) {
    rpad = Array.from(randomBytes(randomBytes(1)[0] % 201), (b) => String.fromCharCode(65 + (b % 26))).join('');
  }
  const jid = (tag: string, v?: string) => (v ? `<${tag} jid='${esc(v)}'/>` : '');
  return utf8(
    `<envelope xmlns='${NS_SCE}'><content><body xmlns='${NS_CLIENT}'>${esc(body)}</body></content>` +
      `<rpad>${esc(rpad)}</rpad>${jid('to', opts.to)}${jid('from', opts.from)}</envelope>`,
  );
}

// Extrae body/to/from del envelope. Parser mínimo: no es un XML completo.
export function parseEnvelope(bytes: Uint8Array): { body: string | null; to?: string; from?: string } {
  const xml = fromUtf8(bytes);
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(xml);
  const attr = (tag: string) => {
    const m = new RegExp(`<${tag}\\s[^>]*jid=(?:'([^']*)'|"([^"]*)")`).exec(xml);
    return m ? unesc(m[1] ?? m[2]) : undefined;
  };
  return { body: body ? unesc(body[1]) : null, to: attr('to'), from: attr('from') };
}
