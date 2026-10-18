// Identidad OMEMO 2: clave Ed25519 (semilla de 32 bytes) y su vista X25519.
// OMEMO 2 usa la clave Ed25519 tal cual como identity key; la firma del signed
// prekey es una firma Ed25519 estándar (verificable con RFC 8032), que es lo
// que producen y aceptan libxeddsa/twomemo para identidades Ed25519.
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, randomBytes } from './bytes';

export interface Identity {
  seed: Uint8Array; // 32 bytes secretos
  pub: Uint8Array; // Ed25519 público (32)
}

export function identityFromSeed(seed: Uint8Array): Identity {
  return { seed, pub: ed25519.getPublicKey(seed) };
}

export function generateIdentity(): Identity {
  return identityFromSeed(randomBytes(32));
}

// Ed25519 público -> X25519 público (mapa de Edwards a Montgomery).
export function edPubToX25519(pub: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomery(pub);
}

// Semilla Ed25519 -> escalar secreto X25519 (SHA-512 + recorte RFC 7748).
export function seedToX25519Secret(seed: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomerySecret(seed);
}

export function signPreKey(seed: Uint8Array, spkPub: Uint8Array): Uint8Array {
  return ed25519.sign(spkPub, seed);
}

export function verifyPreKey(sig: Uint8Array, identityPub: Uint8Array, spkPub: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, spkPub, identityPub);
  } catch {
    return false;
  }
}

// Huella para mostrar: hex minúscula en 8 grupos de 8 (estilo Conversations/Dino).
export function fingerprint(identityPub: Uint8Array): string {
  return bytesToHex(identityPub).match(/.{8}/g)!.join(' ');
}
