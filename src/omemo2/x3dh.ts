// X3DH de OMEMO 2 (XEP-0384 §4.2) con identidad Ed25519.
//   ss = HKDF-SHA-256(salt=0*32, info="OMEMO X3DH", ikm=0xFF*32 || DH1..DH4)
//   ad = IK_activa(Ed25519) || IK_pasiva(Ed25519)
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, randomBytes, utf8 } from './bytes';
import { edPubToX25519, seedToX25519Secret, signPreKey, verifyPreKey } from './identity';

export interface KeyPair {
  priv: Uint8Array;
  pub: Uint8Array;
}

export interface SignedPreKey extends KeyPair {
  id: number;
  sig: Uint8Array;
}

export interface PreKey extends KeyPair {
  id: number;
}

// Bundle público de un dispositivo (lo que se publica en PEP).
export interface Bundle {
  ik: Uint8Array; // Ed25519
  spkId: number;
  spk: Uint8Array;
  spkSig: Uint8Array;
  prekeys: { id: number; pub: Uint8Array }[];
}

export interface X3dhResult {
  ss: Uint8Array;
  ad: Uint8Array;
}

export interface X3dhActiveResult extends X3dhResult {
  ik: Uint8Array; // nuestra Ed25519
  ek: Uint8Array; // efímera pública
  spkId: number;
  spk: Uint8Array;
  pkId: number;
}

const INFO = utf8('OMEMO X3DH');

export function generateKeyPair(): KeyPair {
  const priv = randomBytes(32);
  return { priv, pub: x25519.getPublicKey(priv) };
}

export function generateSignedPreKey(id: number, identitySeed: Uint8Array): SignedPreKey {
  const kp = generateKeyPair();
  return { id, ...kp, sig: signPreKey(identitySeed, kp.pub) };
}

export function generatePreKeys(startId: number, count: number): PreKey[] {
  return Array.from({ length: count }, (_, i) => ({ id: startId + i, ...generateKeyPair() }));
}

function derive(dh: Uint8Array[]): Uint8Array {
  const ikm = concatBytes(new Uint8Array(32).fill(0xff), ...dh);
  return hkdf(sha256, ikm, new Uint8Array(32), INFO, 32);
}

// `prekeyId` elige el one-time prekey del bundle (por defecto uno al azar).
// `ephemeralPriv` sólo para vectores de prueba.
export function x3dhActive(
  ownSeed: Uint8Array,
  ownIkPub: Uint8Array,
  bundle: Bundle,
  prekeyId?: number,
  ephemeralPriv?: Uint8Array,
): X3dhActiveResult {
  if (!verifyPreKey(bundle.spkSig, bundle.ik, bundle.spk)) throw new Error('omemo2: firma del signed prekey inválida');
  if (bundle.prekeys.length === 0) throw new Error('omemo2: bundle sin prekeys');
  const pk =
    prekeyId === undefined
      ? bundle.prekeys[randomBytes(1)[0] % bundle.prekeys.length]
      : bundle.prekeys.find((p) => p.id === prekeyId);
  if (!pk) throw new Error('omemo2: prekey inexistente en el bundle');
  const ekPriv = ephemeralPriv ?? randomBytes(32);
  const ik = seedToX25519Secret(ownSeed);
  const dh = [
    x25519.getSharedSecret(ik, bundle.spk),
    x25519.getSharedSecret(ekPriv, edPubToX25519(bundle.ik)),
    x25519.getSharedSecret(ekPriv, bundle.spk),
    x25519.getSharedSecret(ekPriv, pk.pub),
  ];
  return {
    ss: derive(dh),
    ad: concatBytes(ownIkPub, bundle.ik),
    ik: ownIkPub,
    ek: x25519.getPublicKey(ekPriv),
    spkId: bundle.spkId,
    spk: bundle.spk,
    pkId: pk.id,
  };
}

export function x3dhPassive(
  ownSeed: Uint8Array,
  ownIkPub: Uint8Array,
  spkPriv: Uint8Array,
  prekeyPriv: Uint8Array,
  headerIk: Uint8Array,
  headerEk: Uint8Array,
): X3dhResult {
  const ik = seedToX25519Secret(ownSeed);
  const dh = [
    x25519.getSharedSecret(spkPriv, edPubToX25519(headerIk)),
    x25519.getSharedSecret(ik, headerEk),
    x25519.getSharedSecret(spkPriv, headerEk),
    x25519.getSharedSecret(prekeyPriv, headerEk),
  ];
  return { ss: derive(dh), ad: concatBytes(headerIk, ownIkPub) };
}
