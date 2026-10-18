// Gestor de sesiones OMEMO 2: dispositivo propio (identidad, signed prekeys,
// prekeys), sesiones por (jid, device id) y cifrado/descifrado de mensajes.
// Sin XMPP: trabaja con bytes y modelos; el cableado PEP/stanza va aparte.
import { bytesToHex, ctEqual, hexToBytes, randomBytes } from './bytes';
import { DoubleRatchet } from './doubleRatchet';
import { fingerprint, generateIdentity, identityFromSeed } from './identity';
import { decodeKeyExchange, encodeKeyExchange } from './messages';
import { decryptPayload, encryptPayload } from './payload';
import type { OmemoStore } from './store';
import {
  type Bundle,
  generatePreKeys,
  generateSignedPreKey,
  x3dhActive,
  x3dhPassive,
} from './x3dh';

export interface DeviceRef {
  jid: string;
  rid: number;
}

// Un elemento <key rid kex> de <keys jid>.
export interface EncryptedKey extends DeviceRef {
  kex: boolean;
  data: Uint8Array;
}

export interface EncryptedMessage {
  payload: Uint8Array;
  keys: EncryptedKey[];
}

interface KexHeader {
  ik: string;
  ek: string;
  spkId: number;
  pkId: number;
}

interface SessionRecord {
  dr: ReturnType<DoubleRatchet['toJSON']>;
  peerIk: string;
  pending?: KexHeader; // enviamos KeyExchange hasta recibir algo del par
  passiveEk?: string; // ek del kex que originó una sesión pasiva (reintentos)
}

interface DeviceRecord {
  deviceId: number;
  seed: string;
  spk: { id: number; priv: string; pub: string; sig: string };
  oldSpks: { id: number; priv: string }[];
  prekeys: { id: number; priv: string; pub: string }[];
  nextPkId: number;
}

const KEY_DEVICE = 'omemo2:device';
const sessionKey = (d: DeviceRef) => `omemo2:session:${d.jid}:${d.rid}`;

export class SessionManager {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly store: OmemoStore,
    private dev: DeviceRecord,
  ) {}

  // Carga el dispositivo del store o crea uno nuevo (identidad, spk y `prekeyCount` prekeys).
  static async load(store: OmemoStore, prekeyCount = 100): Promise<SessionManager> {
    const raw = await store.get(KEY_DEVICE);
    if (raw) return new SessionManager(store, JSON.parse(raw));
    const id = generateIdentity();
    const spk = generateSignedPreKey(1, id.seed);
    const m = new SessionManager(store, {
      deviceId: (new DataView(randomBytes(4).buffer).getUint32(0) % 0x7ffffffe) + 1,
      seed: bytesToHex(id.seed),
      spk: { id: spk.id, priv: bytesToHex(spk.priv), pub: bytesToHex(spk.pub), sig: bytesToHex(spk.sig) },
      oldSpks: [],
      prekeys: [],
      nextPkId: 1,
    });
    m.addPreKeys(prekeyCount);
    await m.saveDevice();
    return m;
  }

  get deviceId(): number {
    return this.dev.deviceId;
  }

  get identityPub(): Uint8Array {
    return identityFromSeed(hexToBytes(this.dev.seed)).pub;
  }

  get fingerprint(): string {
    return fingerprint(this.identityPub);
  }

  // Bundle público para publicar en urn:xmpp:omemo:2:bundles.
  bundle(): Bundle {
    const d = this.dev;
    return {
      ik: this.identityPub,
      spkId: d.spk.id,
      spk: hexToBytes(d.spk.pub),
      spkSig: hexToBytes(d.spk.sig),
      prekeys: d.prekeys.map((p) => ({ id: p.id, pub: hexToBytes(p.pub) })),
    };
  }

  // Repone one-time prekeys hasta `target`. True si hay que republicar el bundle.
  ensurePreKeys(target = 100): Promise<boolean> {
    return this.locked(async () => {
      if (this.dev.prekeys.length >= target) return false;
      this.addPreKeys(target - this.dev.prekeys.length);
      await this.saveDevice();
      return true;
    });
  }

  // Nuevo signed prekey; el anterior se conserva para kex en vuelo. Republicar el bundle.
  rotateSignedPreKey(): Promise<void> {
    return this.locked(async () => {
      const d = this.dev;
      d.oldSpks = [{ id: d.spk.id, priv: d.spk.priv }, ...d.oldSpks].slice(0, 2);
      const spk = generateSignedPreKey(d.spk.id + 1, hexToBytes(d.seed));
      d.spk = { id: spk.id, priv: bytesToHex(spk.priv), pub: bytesToHex(spk.pub), sig: bytesToHex(spk.sig) };
      await this.saveDevice();
    });
  }

  async hasSession(dev: DeviceRef): Promise<boolean> {
    return (await this.store.get(sessionKey(dev))) !== null;
  }

  // Identity key (Ed25519) con la que se estableció la sesión, para trust/fingerprints.
  async peerIdentity(dev: DeviceRef): Promise<Uint8Array | null> {
    const rec = await this.loadSession(dev);
    return rec ? hexToBytes(rec.peerIk) : null;
  }

  // X3DH activo contra el bundle del par. Reemplaza cualquier sesión previa con ese dispositivo.
  createSessionFromBundle(dev: DeviceRef, bundle: Bundle, prekeyId?: number): Promise<void> {
    return this.locked(async () => {
      const seed = hexToBytes(this.dev.seed);
      const x = x3dhActive(seed, this.identityPub, bundle, prekeyId);
      const dr = DoubleRatchet.startActive(x.ss, x.ad, bundle.spk);
      await this.saveSession(dev, {
        dr: dr.toJSON(),
        peerIk: bytesToHex(bundle.ik),
        pending: { ik: bytesToHex(x.ik), ek: bytesToHex(x.ek), spkId: x.spkId, pkId: x.pkId },
      });
    });
  }

  // Cifra `plaintext` (normalmente un envelope SCE) para cada dispositivo.
  encryptForDevices(devices: DeviceRef[], plaintext: Uint8Array): Promise<EncryptedMessage> {
    return this.locked(async () => {
      const { payload, keyMaterial } = encryptPayload(plaintext);
      const keys: EncryptedKey[] = [];
      for (const dev of devices) {
        const rec = await this.loadSession(dev);
        if (!rec) throw new Error(`omemo2: sin sesión con ${dev.jid}/${dev.rid}`);
        const dr = DoubleRatchet.fromJSON(rec.dr);
        let data = dr.encrypt(keyMaterial);
        if (rec.pending) {
          data = encodeKeyExchange({
            pkId: rec.pending.pkId,
            spkId: rec.pending.spkId,
            ik: hexToBytes(rec.pending.ik),
            ek: hexToBytes(rec.pending.ek),
            message: data,
          });
        }
        rec.dr = dr.toJSON();
        await this.saveSession(dev, rec);
        keys.push({ ...dev, kex: !!rec.pending, data });
      }
      return { payload, keys };
    });
  }

  // Descifra el <key> dirigido a nosotros. Devuelve el plaintext del payload
  // (null si no hay payload: KeyTransportElement) y la identity key del par.
  decryptFromDevice(
    dev: DeviceRef,
    key: { kex: boolean; data: Uint8Array },
    payload?: Uint8Array,
    expectedIk?: Uint8Array,
  ): Promise<{ plaintext: Uint8Array | null; peerIk: Uint8Array }> {
    return this.locked(async () => {
      let rec = await this.loadSession(dev);
      let keyMaterial: Uint8Array;
      let usedPk: number | undefined;
      if (key.kex) {
        const kex = decodeKeyExchange(key.data);
        const ek = bytesToHex(kex.ek);
        if (rec && rec.passiveEk === ek) {
          // Reenvío del mismo kex: la sesión ya existe.
          const dr = DoubleRatchet.fromJSON(rec.dr);
          keyMaterial = dr.decrypt(kex.message);
          rec.dr = dr.toJSON();
        } else {
          // Un kex nuevo no puede cambiar la identidad del par en silencio:
          // se compara con la esperada (bundle/devicelist) o la ya conocida,
          // antes de consumir prekeys o reemplazar la sesión.
          const known = expectedIk ?? (rec ? hexToBytes(rec.peerIk) : undefined);
          if (known && !ctEqual(known, kex.ik)) throw new Error('omemo2: identity key del par cambió');
          const d = this.dev;
          const spk =
            kex.spkId === d.spk.id ? d.spk : d.oldSpks.find((s) => s.id === kex.spkId);
          const pk = d.prekeys.find((p) => p.id === kex.pkId);
          if (!spk || !pk) throw new Error('omemo2: kex con spk/prekey desconocidos');
          const x = x3dhPassive(
            hexToBytes(d.seed), this.identityPub, hexToBytes(spk.priv), hexToBytes(pk.priv), kex.ik, kex.ek,
          );
          const dr = DoubleRatchet.startPassive(x.ss, x.ad, hexToBytes(spk.priv));
          keyMaterial = dr.decrypt(kex.message);
          rec = { dr: dr.toJSON(), peerIk: bytesToHex(kex.ik), passiveEk: ek };
          usedPk = pk.id;
        }
      } else {
        if (!rec) throw new Error(`omemo2: sin sesión con ${dev.jid}/${dev.rid}`);
        const dr = DoubleRatchet.fromJSON(rec.dr);
        keyMaterial = dr.decrypt(key.data);
        rec.dr = dr.toJSON();
        delete rec.pending; // el par ya tiene nuestra sesión
      }
      const plaintext = payload ? decryptPayload(payload, keyMaterial) : null;
      if (usedPk !== undefined) {
        this.dev.prekeys = this.dev.prekeys.filter((p) => p.id !== usedPk); // un solo uso
        await this.saveDevice();
      }
      await this.saveSession(dev, rec!);
      return { plaintext, peerIk: hexToBytes(rec!.peerIk) };
    });
  }

  private addPreKeys(count: number) {
    for (const p of generatePreKeys(this.dev.nextPkId, count)) {
      this.dev.prekeys.push({ id: p.id, priv: bytesToHex(p.priv), pub: bytesToHex(p.pub) });
    }
    this.dev.nextPkId += count;
  }

  private saveDevice() {
    return this.store.set(KEY_DEVICE, JSON.stringify(this.dev));
  }

  private async loadSession(dev: DeviceRef): Promise<SessionRecord | null> {
    const raw = await this.store.get(sessionKey(dev));
    return raw ? JSON.parse(raw) : null;
  }

  private saveSession(dev: DeviceRef, rec: SessionRecord) {
    return this.store.set(sessionKey(dev), JSON.stringify(rec));
  }

  // Serializa operaciones: cada una lee-modifica-escribe el store.
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
