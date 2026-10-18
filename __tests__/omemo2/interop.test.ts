// Interop en vivo con twomemo; lo orquesta `scripts/omemo2-vectors.py interop`
// (fases 1 y 2 vía OMEMO2_PHASE). Sin OMEMO2_INTEROP_DIR se omite.
import * as fs from 'fs';
import * as path from 'path';
import { x25519 } from '@noble/curves/ed25519';
import {
  DoubleRatchet, bytesToHex as hex, encodeKeyExchange, hexToBytes as h, identityFromSeed, signPreKey, x3dhActive,
} from '../../src/omemo2';

const dir = process.env.OMEMO2_INTEROP_DIR;
const phase = Number(process.env.OMEMO2_PHASE);
const fill = (b: number) => new Uint8Array(48).fill(b);
const A = identityFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i));
const B = identityFromSeed(new Uint8Array(32).fill(1));
const spkPriv = new Uint8Array(32).fill(2);
const pkPriv = new Uint8Array(32).fill(3);
const f = (n: string) => path.join(dir!, n);
const T = dir ? test : test.skip;

T('TS <-> twomemo', () => {
  const spk = x25519.getPublicKey(spkPriv);
  const bundle = {
    ik: B.pub, spkId: 1, spk, spkSig: signPreKey(B.seed, spk), prekeys: [{ id: 5, pub: x25519.getPublicKey(pkPriv) }],
  };
  const x = x3dhActive(A.seed, A.pub, bundle, 5, new Uint8Array(32).fill(4));
  if (phase === 1) {
    const dr = DoubleRatchet.startActive(x.ss, x.ad, spk);
    const plain = [fill(0xa0), fill(0xa1), fill(0xa2)];
    const [c0, c1, c2] = plain.map((p) => dr.encrypt(p));
    const kex = encodeKeyExchange({ pkId: x.pkId, spkId: x.spkId, ik: x.ik, ek: x.ek, message: c0 });
    fs.writeFileSync(
      f('ts1.json'),
      JSON.stringify({ kex: hex(kex), msgs: [hex(c1), hex(c2)], plain: plain.map(hex), state: dr.toJSON() }),
    );
  } else {
    const t1 = JSON.parse(fs.readFileSync(f('ts1.json'), 'utf8'));
    const py = JSON.parse(fs.readFileSync(f('py.json'), 'utf8'));
    const dr = DoubleRatchet.fromJSON(t1.state);
    expect(hex(dr.decrypt(h(py.ct[1])))).toBe(py.plain[1]); // salta r0 (paso DH)
    expect(hex(dr.decrypt(h(py.ct[0])))).toBe(py.plain[0]);
    const plain = fill(0xd0);
    fs.writeFileSync(f('ts2.json'), JSON.stringify({ ct: hex(dr.encrypt(plain)), plain: hex(plain) }));
  }
});
