// Protobuf mínimo (proto2, escrito a mano) de OMEMO 2. Campos siempre
// presentes y en orden de número, igual que serializa twomemo.
//   OMEMOMessage{n=1 pn=2 dh_pub=3 ciphertext=4}
//   OMEMOAuthenticatedMessage{mac=1 message=2}
//   OMEMOKeyExchange{pk_id=1 spk_id=2 ik=3 ek=4 message=5}
import { concatBytes } from './bytes';

function varint(v: number): Uint8Array {
  const out: number[] = [];
  let n = v;
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Uint8Array.from(out);
}

const varintField = (field: number, v: number) => concatBytes(varint(field << 3), varint(v));
const bytesField = (field: number, b: Uint8Array) => concatBytes(varint((field << 3) | 2), varint(b.length), b);

type Field = number | Uint8Array;

// Última aparición de cada campo; lanza ante wire types distintos de 0 y 2 o datos truncados.
function parse(buf: Uint8Array): Map<number, Field> {
  const out = new Map<number, Field>();
  let i = 0;
  const read = (): number => {
    let v = 0;
    let mul = 1;
    for (let k = 0; k < 10; k++) {
      if (i >= buf.length) throw new Error('omemo2: protobuf truncado');
      const b = buf[i++];
      v += (b & 0x7f) * mul;
      if (!(b & 0x80)) return v;
      mul *= 0x80;
    }
    throw new Error('omemo2: varint demasiado largo');
  };
  while (i < buf.length) {
    const tag = read();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) out.set(field, read());
    else if (wire === 2) {
      const len = read();
      if (i + len > buf.length) throw new Error('omemo2: protobuf truncado');
      out.set(field, buf.subarray(i, i + len));
      i += len;
    } else throw new Error('omemo2: wire type no soportado');
  }
  return out;
}

function need<T extends Field>(m: Map<number, Field>, f: number, type: 'number' | 'bytes'): T {
  const v = m.get(f);
  if (v === undefined || (type === 'number') !== (typeof v === 'number')) throw new Error(`omemo2: campo ${f} ausente o inválido`);
  return v as T;
}

export interface OmemoMessage {
  n: number;
  pn: number;
  dhPub: Uint8Array;
  ciphertext: Uint8Array;
}

export function encodeMessage(m: OmemoMessage): Uint8Array {
  return concatBytes(varintField(1, m.n), varintField(2, m.pn), bytesField(3, m.dhPub), bytesField(4, m.ciphertext));
}

export function decodeMessage(buf: Uint8Array): OmemoMessage {
  const f = parse(buf);
  return {
    n: need<number>(f, 1, 'number'),
    pn: need<number>(f, 2, 'number'),
    dhPub: need<Uint8Array>(f, 3, 'bytes'),
    ciphertext: need<Uint8Array>(f, 4, 'bytes'),
  };
}

export interface AuthenticatedMessage {
  mac: Uint8Array;
  message: Uint8Array; // OMEMOMessage crudo (el MAC cubre estos bytes exactos)
}

export function encodeAuthenticated(a: AuthenticatedMessage): Uint8Array {
  return concatBytes(bytesField(1, a.mac), bytesField(2, a.message));
}

export function decodeAuthenticated(buf: Uint8Array): AuthenticatedMessage {
  const f = parse(buf);
  return { mac: need<Uint8Array>(f, 1, 'bytes'), message: need<Uint8Array>(f, 2, 'bytes') };
}

export interface KeyExchange {
  pkId: number;
  spkId: number;
  ik: Uint8Array;
  ek: Uint8Array;
  message: Uint8Array; // OMEMOAuthenticatedMessage
}

export function encodeKeyExchange(k: KeyExchange): Uint8Array {
  return concatBytes(
    varintField(1, k.pkId),
    varintField(2, k.spkId),
    bytesField(3, k.ik),
    bytesField(4, k.ek),
    bytesField(5, k.message),
  );
}

export function decodeKeyExchange(buf: Uint8Array): KeyExchange {
  const f = parse(buf);
  return {
    pkId: need<number>(f, 1, 'number'),
    spkId: need<number>(f, 2, 'number'),
    ik: need<Uint8Array>(f, 3, 'bytes'),
    ek: need<Uint8Array>(f, 4, 'bytes'),
    message: need<Uint8Array>(f, 5, 'bytes'),
  };
}
