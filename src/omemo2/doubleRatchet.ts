// Double Ratchet de OMEMO 2 (compatible con twomemo/doubleratchet de Syndace).
//   root:  HKDF-SHA-256(ikm=DH, salt=root, info="OMEMO Root Chain") -> root'(32) || chain(32)
//   chain: mk=HMAC(ck,0x01), ck'=HMAC(ck,0x02)
//   AEAD:  HKDF(mk, salt=0*32, "OMEMO Message Key Material") -> enc(32) auth(32) iv(16);
//          AES-256-CBC; mac = HMAC(auth, AD || OMEMOMessage)[:16]
import { x25519 } from '@noble/curves/ed25519';
import { cbc } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, ctEqual, hexToBytes, randomBytes, utf8 } from './bytes';
import { decodeAuthenticated, decodeMessage, encodeAuthenticated, encodeMessage } from './messages';

export const MAX_SKIP = 1000;
const INFO_ROOT = utf8('OMEMO Root Chain');
const INFO_MSG = utf8('OMEMO Message Key Material');

interface Skipped {
  pub: string; // hex del ratchet público
  n: number;
  mk: string; // hex
}

interface State {
  ad: Uint8Array; // 64 bytes de X3DH
  root: Uint8Array;
  ownPriv: Uint8Array;
  otherPub: Uint8Array | null;
  sendCk: Uint8Array | null;
  sendN: number;
  recvCk: Uint8Array | null;
  recvN: number;
  pn: number;
  skipped: Skipped[];
}

const rootStep = (root: Uint8Array, dh: Uint8Array) => {
  const okm = hkdf(sha256, dh, root, INFO_ROOT, 64);
  return { root: okm.slice(0, 32), ck: okm.slice(32) };
};

const chainStep = (ck: Uint8Array) => ({
  ck: hmac(sha256, ck, Uint8Array.of(2)),
  mk: hmac(sha256, ck, Uint8Array.of(1)),
});

function aeadKeys(mk: Uint8Array) {
  const okm = hkdf(sha256, mk, new Uint8Array(32), INFO_MSG, 80);
  return { enc: okm.subarray(0, 32), auth: okm.subarray(32, 64), iv: okm.subarray(64, 80) };
}

export class DoubleRatchet {
  private constructor(private s: State) {}

  // Lado activo: `ss`/`ad` de X3DH y el signed prekey del par como ratchet público inicial.
  static startActive(ss: Uint8Array, ad: Uint8Array, recipientRatchetPub: Uint8Array): DoubleRatchet {
    const ownPriv = randomBytes(32);
    const r = rootStep(ss, x25519.getSharedSecret(ownPriv, recipientRatchetPub));
    return new DoubleRatchet({
      ad, root: r.root, ownPriv, otherPub: recipientRatchetPub,
      sendCk: r.ck, sendN: 0, recvCk: null, recvN: 0, pn: 0, skipped: [],
    });
  }

  // Lado pasivo: el ratchet inicial es el signed prekey; el primer decrypt() hace el paso DH.
  static startPassive(ss: Uint8Array, ad: Uint8Array, ownRatchetPriv: Uint8Array): DoubleRatchet {
    return new DoubleRatchet({
      ad, root: ss, ownPriv: ownRatchetPriv, otherPub: null,
      sendCk: null, sendN: 0, recvCk: null, recvN: 0, pn: 0, skipped: [],
    });
  }

  // Devuelve un OMEMOAuthenticatedMessage.
  encrypt(plaintext: Uint8Array): Uint8Array {
    const s = this.s;
    if (!s.sendCk) throw new Error('omemo2: sesión sin cadena de envío');
    const step = chainStep(s.sendCk);
    const k = aeadKeys(step.mk);
    const message = encodeMessage({
      n: s.sendN, pn: s.pn, dhPub: x25519.getPublicKey(s.ownPriv),
      ciphertext: cbc(k.enc, k.iv).encrypt(plaintext),
    });
    const mac = hmac(sha256, k.auth, concatBytes(s.ad, message)).subarray(0, 16);
    s.sendCk = step.ck;
    s.sendN++;
    return encodeAuthenticated({ mac, message });
  }

  // Transaccional: si algo falla (MAC, duplicado, límite) el estado queda intacto.
  decrypt(data: Uint8Array): Uint8Array {
    const auth = decodeAuthenticated(data);
    const msg = decodeMessage(auth.message);
    if (msg.dhPub.length !== 32 || auth.mac.length !== 16) throw new Error('omemo2: mensaje malformado');
    const s: State = { ...this.s, skipped: [...this.s.skipped] };
    const pubHex = bytesToHex(msg.dhPub);

    const open = (mk: Uint8Array): Uint8Array => {
      const k = aeadKeys(mk);
      const want = hmac(sha256, k.auth, concatBytes(s.ad, auth.message)).subarray(0, 16);
      if (!ctEqual(want, auth.mac)) throw new Error('omemo2: MAC inválido');
      return cbc(k.enc, k.iv).decrypt(msg.ciphertext);
    };
    const skipTo = (until: number) => {
      if (!s.recvCk) return;
      if (until - s.recvN > MAX_SKIP) throw new Error('omemo2: demasiados mensajes salteados');
      while (s.recvN < until) {
        const step = chainStep(s.recvCk);
        s.skipped.push({ pub: bytesToHex(s.otherPub!), n: s.recvN, mk: bytesToHex(step.mk) });
        if (s.skipped.length > MAX_SKIP) s.skipped.shift(); // FIFO
        s.recvCk = step.ck;
        s.recvN++;
      }
    };

    const idx = s.skipped.findIndex((e) => e.pub === pubHex && e.n === msg.n);
    let plain: Uint8Array;
    if (idx >= 0) {
      plain = open(hexToBytes(s.skipped[idx].mk));
      s.skipped.splice(idx, 1);
    } else {
      if (!s.otherPub || !ctEqual(s.otherPub, msg.dhPub)) {
        skipTo(msg.pn); // cierra la cadena anterior
        s.otherPub = msg.dhPub;
        const r1 = rootStep(s.root, x25519.getSharedSecret(s.ownPriv, msg.dhPub));
        s.recvCk = r1.ck;
        s.recvN = 0;
        s.pn = s.sendN;
        s.ownPriv = randomBytes(32);
        const r2 = rootStep(r1.root, x25519.getSharedSecret(s.ownPriv, msg.dhPub));
        s.root = r2.root;
        s.sendCk = r2.ck;
        s.sendN = 0;
      }
      if (msg.n < s.recvN) throw new Error('omemo2: mensaje duplicado');
      skipTo(msg.n);
      const step = chainStep(s.recvCk!);
      plain = open(step.mk);
      s.recvCk = step.ck;
      s.recvN++;
    }
    this.s = s;
    return plain;
  }

  toJSON() {
    const s = this.s;
    const h = (b: Uint8Array | null) => (b ? bytesToHex(b) : null);
    return {
      v: 1, ad: h(s.ad), root: h(s.root), ownPriv: h(s.ownPriv), otherPub: h(s.otherPub),
      sendCk: h(s.sendCk), sendN: s.sendN, recvCk: h(s.recvCk), recvN: s.recvN, pn: s.pn, skipped: s.skipped,
    };
  }

  static fromJSON(j: ReturnType<DoubleRatchet['toJSON']>): DoubleRatchet {
    if (j.v !== 1) throw new Error('omemo2: versión de estado desconocida');
    const b = (x: string | null) => (x ? hexToBytes(x) : null);
    return new DoubleRatchet({
      ad: hexToBytes(j.ad!), root: hexToBytes(j.root!), ownPriv: hexToBytes(j.ownPriv!), otherPub: b(j.otherPub),
      sendCk: b(j.sendCk), sendN: j.sendN, recvCk: b(j.recvCk), recvN: j.recvN, pn: j.pn, skipped: j.skipped,
    });
  }
}
