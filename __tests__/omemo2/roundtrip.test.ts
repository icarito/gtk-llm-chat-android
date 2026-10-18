import { x25519 } from '@noble/curves/ed25519';
import {
  DoubleRatchet, MAX_SKIP, MemoryStore, SessionManager, buildEnvelope, parseEnvelope, randomBytes,
} from '../../src/omemo2';

const u = (s: string) => new TextEncoder().encode(s);
const s8 = (b: Uint8Array | null) => new TextDecoder().decode(b!);

function pair() {
  const ss = randomBytes(32);
  const ad = randomBytes(64);
  const spk = randomBytes(32);
  const alice = DoubleRatchet.startActive(ss, ad, x25519.getPublicKey(spk));
  const bob = DoubleRatchet.startPassive(ss, ad, spk);
  return { alice, bob };
}

describe('Double Ratchet', () => {
  test('ida y vuelta con varios pasos DH, serializando entre mensajes', () => {
    let { alice, bob } = pair();
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 3; i++) {
        const m = `a${round}.${i}`;
        expect(s8(bob.decrypt(alice.encrypt(u(m))))).toBe(m);
        bob = DoubleRatchet.fromJSON(JSON.parse(JSON.stringify(bob.toJSON())));
      }
      for (let i = 0; i < 2; i++) {
        const m = `b${round}.${i}`;
        expect(s8(alice.decrypt(bob.encrypt(u(m))))).toBe(m);
        alice = DoubleRatchet.fromJSON(JSON.parse(JSON.stringify(alice.toJSON())));
      }
    }
  });

  test('fuera de orden a través de un paso DH (pn) y duplicados', () => {
    const { alice, bob } = pair();
    const a = [0, 1, 2].map((i) => alice.encrypt(u(`a${i}`)));
    expect(s8(bob.decrypt(a[0]))).toBe('a0');
    const b = [0, 1].map((i) => bob.encrypt(u(`b${i}`)));
    expect(s8(alice.decrypt(b[1]))).toBe('b1'); // b0 queda salteado
    const a3 = alice.encrypt(u('a3')); // nueva cadena de Alice (pn=3)
    expect(s8(bob.decrypt(a3))).toBe('a3'); // a1, a2 salteados en la cadena vieja
    expect(s8(bob.decrypt(a[2]))).toBe('a2');
    expect(s8(bob.decrypt(a[1]))).toBe('a1');
    expect(s8(alice.decrypt(b[0]))).toBe('b0');
    expect(() => bob.decrypt(a[1])).toThrow();
  });

  test('un mensaje inválido no altera el estado', () => {
    const { alice, bob } = pair();
    const m = alice.encrypt(u('hola'));
    const bad = m.slice();
    bad[bad.length - 1] ^= 1;
    const before = JSON.stringify(bob.toJSON());
    expect(() => bob.decrypt(bad)).toThrow();
    expect(JSON.stringify(bob.toJSON())).toBe(before);
    expect(s8(bob.decrypt(m))).toBe('hola');
  });

  test('límite de claves salteadas', () => {
    const { alice, bob } = pair();
    for (let i = 0; i < MAX_SKIP + 1; i++) alice.encrypt(u('x'));
    expect(() => bob.decrypt(alice.encrypt(u('lejos')))).toThrow(/salteados/);
    const { alice: a2, bob: b2 } = pair();
    for (let i = 0; i < MAX_SKIP; i++) a2.encrypt(u('x'));
    expect(s8(b2.decrypt(a2.encrypt(u('justo'))))).toBe('justo');
  });
});

describe('payload SCE', () => {
  test('envelope: escape y campos', () => {
    const env = buildEnvelope('a <b> & "c"', { to: 'bob@x.org', from: 'alice@x.org/r' });
    expect(parseEnvelope(env)).toEqual({ body: 'a <b> & "c"', to: 'bob@x.org', from: 'alice@x.org/r' });
    expect(s8(env)).toContain("xmlns='urn:xmpp:sce:1'");
  });
});

describe('SessionManager', () => {
  const alice = { jid: 'alice@x.org' };
  const bob = { jid: 'bob@x.org' };

  async function setup() {
    const sa = new MemoryStore();
    const sb = new MemoryStore();
    const A = await SessionManager.load(sa, 5);
    const B = await SessionManager.load(sb, 5);
    return { sa, sb, A, B, ra: { ...alice, rid: A.deviceId }, rb: { ...bob, rid: B.deviceId } };
  }

  test('X3DH + kex, respuesta, persistencia y prekey de un solo uso', async () => {
    const { sa, sb, A, B, ra, rb } = await setup();
    await A.createSessionFromBundle(rb, B.bundle());
    const e1 = await A.encryptForDevices([rb], buildEnvelope('hola', { to: bob.jid }));
    expect(e1.keys[0].kex).toBe(true);
    const e1b = await A.encryptForDevices([rb], buildEnvelope('hola 2'));
    expect(e1b.keys[0].kex).toBe(true); // sigue hasta que Bob responda

    // Bob recarga su estado desde el store antes de descifrar.
    let B2 = await SessionManager.load(sb);
    const prekeysBefore = B2.bundle().prekeys.length;
    const r1 = await B2.decryptFromDevice(ra, e1.keys[0], e1.payload);
    expect(parseEnvelope(r1.plaintext!).body).toBe('hola');
    expect(r1.peerIk).toEqual(A.identityPub);
    expect(B2.bundle().prekeys.length).toBe(prekeysBefore - 1);
    // El segundo kex (misma efímera) usa la sesión existente aunque el prekey ya no esté.
    const r1b = await B2.decryptFromDevice(ra, e1b.keys[0], e1b.payload);
    expect(parseEnvelope(r1b.plaintext!).body).toBe('hola 2');

    B2 = await SessionManager.load(sb);
    const e2 = await B2.encryptForDevices([ra], buildEnvelope('respuesta'));
    expect(e2.keys[0].kex).toBe(false);
    const A2 = await SessionManager.load(sa);
    expect(parseEnvelope((await A2.decryptFromDevice(rb, e2.keys[0], e2.payload)).plaintext!).body).toBe('respuesta');
    const e3 = await A2.encryptForDevices([rb], buildEnvelope('ya sin kex'));
    expect(e3.keys[0].kex).toBe(false);
    expect(parseEnvelope((await B2.decryptFromDevice(ra, e3.keys[0], e3.payload)).plaintext!).body).toBe('ya sin kex');
  });

  test('varios dispositivos de destino y mismo payload', async () => {
    const { A, B, rb } = await setup();
    const C = await SessionManager.load(new MemoryStore(), 3);
    const rc = { jid: 'carol@x.org', rid: C.deviceId };
    await A.createSessionFromBundle(rb, B.bundle());
    await A.createSessionFromBundle(rc, C.bundle());
    const e = await A.encryptForDevices([rb, rc], u('x'));
    expect(e.keys).toHaveLength(2);
    const ra = { ...alice, rid: A.deviceId };
    expect(s8((await B.decryptFromDevice(ra, e.keys[0], e.payload)).plaintext)).toBe('x');
    expect(s8((await C.decryptFromDevice(ra, e.keys[1], e.payload)).plaintext)).toBe('x');
  });

  test('fallos: firma de spk inválida, HMAC alterado, rid sin sesión, kex con prekey desconocido', async () => {
    const { A, B, ra, rb } = await setup();
    const bad = B.bundle();
    bad.spkSig = bad.spkSig.slice();
    bad.spkSig[0] ^= 1;
    await expect(A.createSessionFromBundle(rb, bad)).rejects.toThrow(/firma/);
    await expect(A.encryptForDevices([rb], u('x'))).rejects.toThrow(/sin sesión/);

    await A.createSessionFromBundle(rb, B.bundle());
    const e = await A.encryptForDevices([rb], u('x'));
    const tampered = e.payload.slice();
    tampered[0] ^= 1;
    await expect(B.decryptFromDevice(ra, e.keys[0], tampered)).rejects.toThrow(/HMAC/);
    // El fallo no consumió el prekey: el mensaje legítimo sigue descifrando.
    expect(s8((await B.decryptFromDevice(ra, e.keys[0], e.payload)).plaintext)).toBe('x');
    await expect(B.decryptFromDevice({ ...ra, rid: 1 }, { kex: false, data: e.keys[0].data })).rejects.toThrow(/sin sesión/);

    const other = await SessionManager.load(new MemoryStore(), 1);
    await expect(other.decryptFromDevice(ra, e.keys[0], e.payload)).rejects.toThrow();
  });

  test('rotación de spk y reposición de prekeys; kex con el spk anterior sigue válido', async () => {
    const { A, B, ra, rb } = await setup();
    const oldBundle = B.bundle();
    await A.createSessionFromBundle(rb, oldBundle);
    await B.rotateSignedPreKey();
    expect(B.bundle().spkId).toBe(oldBundle.spkId + 1);
    const e = await A.encryptForDevices([rb], u('tarde'));
    expect(s8((await B.decryptFromDevice(ra, e.keys[0], e.payload)).plaintext)).toBe('tarde');
    expect(await B.ensurePreKeys(5)).toBe(true);
    expect(B.bundle().prekeys).toHaveLength(5);
    expect(await B.ensurePreKeys(5)).toBe(false);
  });
});

describe('auditoría', () => {
  it('rechaza kex con identity key inesperada sin tocar el estado', async () => {
    const bob = await SessionManager.load(new MemoryStore(), 5);
    const eve = await SessionManager.load(new MemoryStore(), 5);
    const bobDev = { jid: 'bob@x', rid: bob.deviceId };
    await eve.createSessionFromBundle(bobDev, bob.bundle());
    const out = await eve.encryptForDevices([bobDev], new TextEncoder().encode('evil'));
    const k = out.keys[0];
    const alice = await SessionManager.load(new MemoryStore(), 5);
    await expect(
      bob.decryptFromDevice({ jid: 'alice@x', rid: 1 }, { kex: k.kex, data: k.data }, out.payload, alice.identityPub),
    ).rejects.toThrow('identity key');
    expect(bob.bundle().prekeys.length).toBe(5);
  });
});
