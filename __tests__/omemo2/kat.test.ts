// Known-answer tests: vectores generados con twomemo/doubleratchet/x3dh/xeddsa
// (scripts/omemo2-vectors.py gen) y el vector de payload de xat.
import vectors from './vectors.json';
import {
  DoubleRatchet, bytesToHex, decodeAuthenticated, decodeKeyExchange, decodeMessage, decryptPayload,
  edPubToX25519, encodeAuthenticated, encodeKeyExchange, encodeMessage, encryptPayload, fingerprint,
  generateIdentity, hexToBytes as h, identityFromSeed, seedToX25519Secret, verifyPreKey, x3dhActive, x3dhPassive,
} from '../../src/omemo2';
import { x25519 } from '@noble/curves/ed25519';

const hex = bytesToHex;

test('identidad: pública, conversión X25519 y firma de la referencia', () => {
  const v = vectors.identity;
  const id = identityFromSeed(h(v.seed));
  expect(hex(id.pub)).toBe(v.pub);
  expect(hex(edPubToX25519(id.pub))).toBe(v.x25519Pub);
  expect(hex(seedToX25519Secret(id.seed))).toBe(v.x25519Secret);
  expect(hex(x25519.getPublicKey(seedToX25519Secret(id.seed)))).toBe(v.x25519Pub);
  expect(verifyPreKey(h(v.spkSig), id.pub, h(v.spkPub))).toBe(true);
  const bad = h(v.spkSig);
  bad[0] ^= 1;
  expect(verifyPreKey(bad, id.pub, h(v.spkPub))).toBe(false);
  expect(fingerprint(id.pub)).toMatch(/^([0-9a-f]{8} ){7}[0-9a-f]{8}$/);
  expect(generateIdentity().pub).toHaveLength(32);
});

test('firma xeddsa de xat (identidad 00..1f) verifica', () => {
  const sig = h('4394a30210af2ecaf87ef4b0ee2c86fa65eaa313190038ba0b57b3aed47b9e947dac0832b9b3831c2ee8dffd9b051c017766dbac7ffe437add7c810d2c50710d');
  const pub = h('03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8');
  expect(hex(identityFromSeed(h(vectors.identity.seed)).pub)).toBe(hex(pub));
  expect(verifyPreKey(sig, pub, new TextEncoder().encode('xat signed prekey'))).toBe(true);
});

test('X3DH activo y pasivo igualan a la librería (ss, ad)', () => {
  const v = vectors.x3dh;
  const a = identityFromSeed(h(v.aSeed));
  const b = identityFromSeed(h(v.bSeed));
  const spkPub = x25519.getPublicKey(h(v.bSpkPriv));
  const bundle = {
    ik: b.pub, spkId: 1, spk: spkPub, spkSig: h(v.bSpkSig),
    prekeys: [{ id: 7, pub: x25519.getPublicKey(h(v.bPrekeyPriv)) }],
  };
  const act = x3dhActive(a.seed, a.pub, bundle, 7, h(v.aEphemeral));
  expect(hex(act.ss)).toBe(v.ss);
  expect(hex(act.ad)).toBe(v.ad);
  expect(hex(act.ik)).toBe(v.headerIk);
  expect(hex(act.ek)).toBe(v.headerEk);
  const pas = x3dhPassive(b.seed, b.pub, h(v.bSpkPriv), h(v.bPrekeyPriv), h(v.headerIk), h(v.headerEk));
  expect(hex(pas.ss)).toBe(v.ss);
  expect(hex(pas.ad)).toBe(v.ad);
  // Firma de spk alterada -> rechazo.
  const sig = h(v.bSpkSig);
  sig[3] ^= 1;
  expect(() => x3dhActive(a.seed, a.pub, { ...bundle, spkSig: sig })).toThrow(/firma/);
});

test('payload: vector de la referencia y de xat', () => {
  const v = vectors.payload;
  const enc = encryptPayload(h(v.plaintext), h(v.key));
  expect(hex(enc.payload)).toBe(v.payload);
  expect(hex(enc.keyMaterial)).toBe(v.keyMaterial);
  expect(hex(decryptPayload(h(v.payload), h(v.keyMaterial)))).toBe(v.plaintext);
  // xat (omemo_node.cpp self_test): "hola" sin envelope.
  const km = h('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f6032e091967d4a46c46e5706855512ca');
  expect(new TextDecoder().decode(decryptPayload(h('2c450ccc8ab79c1862cc619b8b898342'), km))).toBe('hola');
  const tampered = h(v.keyMaterial);
  tampered[40] ^= 1;
  expect(() => decryptPayload(h(v.payload), tampered)).toThrow(/HMAC/);
});

test('protobuf: bytes idénticos a los de protobuf de la librería', () => {
  const v = vectors.protobuf;
  const m = { n: 3, pn: 200, dhPub: new Uint8Array(32).fill(7), ciphertext: new Uint8Array(40).fill(9) };
  expect(hex(encodeMessage(m))).toBe(v.message);
  expect(decodeMessage(h(v.message))).toEqual(m);
  const a = { mac: new Uint8Array(16).fill(5), message: h(v.message) };
  expect(hex(encodeAuthenticated(a))).toBe(v.authenticated);
  expect(decodeAuthenticated(h(v.authenticated))).toEqual(a);
  const k = {
    pkId: 300, spkId: 2, ik: h(vectors.identity.pub), ek: new Uint8Array(32).fill(4), message: h(v.authenticated),
  };
  expect(hex(encodeKeyExchange(k))).toBe(v.kex);
  expect(decodeKeyExchange(h(v.kex))).toEqual(k);
  expect(() => decodeKeyExchange(h(v.kex).subarray(0, 20))).toThrow();
});

test('Double Ratchet: la librería activa -> TS pasivo, con mensajes fuera de orden', () => {
  const v = vectors.dr;
  const dr = DoubleRatchet.startPassive(h(v.ss), h(v.ad), h(v.ownRatchetPriv));
  const [m0, m1, m2] = v.messages;
  expect(hex(dr.decrypt(h(m0.ciphertext)))).toBe(m0.plaintext);
  expect(hex(dr.decrypt(h(m2.ciphertext)))).toBe(m2.plaintext); // salta m1
  expect(hex(dr.decrypt(h(m1.ciphertext)))).toBe(m1.plaintext);
  expect(() => dr.decrypt(h(m1.ciphertext))).toThrow(); // duplicado
});
