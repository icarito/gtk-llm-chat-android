/**
 * OMEMO 2 (XEP-0384 v0.8+, `urn:xmpp:omemo:2`) sobre el núcleo puro de
 * src/omemo2: publicación de device list/bundle (PEP), cifrado/descifrado de
 * mensajes 1:1 y confianza BTBV. El núcleo no sabe de XMPP; aquí vive todo el
 * cableado de stanzas. La clase es testeable con deps falsas (request/send);
 * el singleton del final la une a la conexión real.
 *
 * Contratos que no se ven en el código:
 *  - El `from` del envelope SCE debe coincidir con el bare JID del remitente de
 *    la stanza (si el envelope lo trae); si no, el mensaje se rechaza.
 *  - Salas (XEP-0384 §7): sólo no anónimas; los destinatarios son los JIDs reales
 *    de los miembros y el envelope SCE lleva la sala como `to`. El `from` del
 *    envelope se compara con el JID real resuelto del remitente (no con la sala).
 *  - BTBV: un dispositivo nuevo es 'blind' mientras ningún dispositivo de ese
 *    JID esté 'verified'; después los nuevos nacen 'distrusted' y ni se les
 *    cifra ni se muestran sus mensajes. Un cambio de identity key de un rid
 *    conocido nunca se acepta en silencio (evento onIdentityChanged).
 *  - Una stanza ya consumida por el ratchet (MAM tras recibirla en vivo, o la
 *    copia MAM de lo que enviamos) no se puede descifrar otra vez: por eso el
 *    plaintext se guarda cifrado en reposo por (jid, id) y se usa de respaldo.
 */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import {
  KeyTransportCounter,
  SessionManager,
  SPK_MAX_AGE_MS,
  b64decode,
  b64encode,
  buildEnvelope,
  bytesToHex,
  decodeKeyExchange,
  fingerprint,
  hexToBytes,
  parseEnvelope,
  type Bundle,
  type DeviceRef,
  type EncryptedMessage,
  type OmemoStore,
} from '@/omemo2';
import { SqliteOmemoStore } from '@/omemo2/sqliteStore';
import { PUBSUB_EVENT_NS, PUBSUB_NS } from '@/xmpp/ns';
import { bareJid } from '@/xmpp/parse';
import { usableClient } from '@/xmpp/session';

export const NS_OMEMO2 = 'urn:xmpp:omemo:2';
export const NODE_DEVICES = `${NS_OMEMO2}:devices`;
export const NODE_BUNDLES = `${NS_OMEMO2}:bundles`;
export const OMEMO2_FALLBACK_BODY = '[Este mensaje está cifrado con OMEMO 2]';

const PREKEY_MIN = 25; // bajo este número de prekeys en el bundle, se repone y republica
const PREKEY_TARGET = 100;
const KEY_TRANSPORT_AFTER = 53; // mensajes recibidos de un dispositivo sin contestarle (XEP-0384 §4.6)
const NO_LIST = ['item-not-found', 'service-unavailable', 'feature-not-implemented', 'forbidden', 'remote-server-not-found'];
const WIRE_KEY = 'omemo2:wire';
// Por (conversación, remitente, id): un mismo id en otro contexto no debe colisionar.
const plainKey = (conv: string, sender: string, id: string) => `omemo2:plain:${conv}:${sender}:${id}`;
const legacyPlainKey = (sender: string, id: string) => `omemo2:plain:${sender}:${id}`;

export type TrustState = 'blind' | 'verified' | 'distrusted';

export interface Omemo2Device {
  jid: string;
  rid: number;
  own: boolean;
  /** Ed25519 identity key en hex; null mientras no hayamos visto su bundle/mensajes. */
  identity: string | null;
  fingerprint: string | null;
  trusted: TrustState | null;
}

export interface IdentityChange {
  jid: string;
  rid: number;
  oldIdentity: string | null;
  newIdentity: string | null;
}

export interface Omemo2Result {
  /** Texto del mensaje, o placeholder si es undecryptable. '' si no hay nada que mostrar (key transport). */
  body: string;
  status: 'omemo2' | 'undecryptable';
}

export interface Omemo2Deps {
  /** JID propio (bare o full). */
  jid: string;
  store: OmemoStore;
  request(iq: Element): Promise<Element>;
  send(stanza: Element): Promise<void>;
}

interface WireState {
  enabled: Record<string, boolean>;
  devices: Record<string, number[]>;
  trust: Record<string, { identity: string; trusted: TrustState }>;
}

const tk = (jid: string, rid: number) => `${jid}:${rid}`;
const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value));

export class Omemo2Engine {
  readonly ownBare: string;
  private listeners = new Set<() => void>();
  private identityListeners = new Set<(c: IdentityChange) => void>();
  private reported = new Set<string>();
  private kt: KeyTransportCounter;
  private snapshots = new Map<string, Omemo2Device[]>();

  private constructor(
    private readonly deps: Omemo2Deps,
    private readonly sm: SessionManager,
    private readonly state: WireState,
  ) {
    this.ownBare = bareJid(deps.jid);
    this.kt = new KeyTransportCounter(deps.store);
  }

  static async create(deps: Omemo2Deps): Promise<Omemo2Engine> {
    const sm = await SessionManager.load(deps.store, PREKEY_TARGET);
    const raw = await deps.store.get(WIRE_KEY);
    const state: WireState = { enabled: {}, devices: {}, trust: {}, ...(raw ? JSON.parse(raw) : {}) };
    return new Omemo2Engine(deps, sm, state);
  }

  // ── Estado observable ──

  get deviceId(): number {
    return this.sm.deviceId;
  }

  get ownFingerprint(): string {
    return this.sm.fingerprint;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onIdentityChanged(cb: (c: IdentityChange) => void): () => void {
    this.identityListeners.add(cb);
    return () => this.identityListeners.delete(cb);
  }

  /** Snapshot estable por JID (misma referencia mientras nada cambie). */
  devices(jid: string): Omemo2Device[] {
    const bare = bareJid(jid);
    let snap = this.snapshots.get(bare);
    if (!snap) {
      snap = (this.state.devices[bare] ?? []).map((rid) => {
        const t = this.state.trust[tk(bare, rid)];
        return {
          jid: bare,
          rid,
          own: bare === this.ownBare && rid === this.deviceId,
          identity: t?.identity ?? null,
          fingerprint: t ? fingerprint(hexToBytes(t.identity)) : null,
          trusted: t?.trusted ?? null,
        };
      });
      this.snapshots.set(bare, snap);
    }
    return snap;
  }

  isEnabledFor(jid: string): boolean {
    return this.state.enabled[bareJid(jid)] ?? true;
  }

  async setEnabledFor(jid: string, enabled: boolean): Promise<void> {
    this.state.enabled[bareJid(jid)] = enabled;
    await this.changed();
  }

  /** `identity` (hex) sólo para aceptar un cambio de identity key que el usuario revisó. */
  async setTrust(jid: string, rid: number, trusted: TrustState, identity?: string): Promise<boolean> {
    const bare = bareJid(jid);
    const prev = this.state.trust[tk(bare, rid)];
    if (!prev && !identity) return false;
    this.state.trust[tk(bare, rid)] = { identity: identity ?? prev!.identity, trusted };
    this.reported.delete(tk(bare, rid));
    await this.changed();
    return true;
  }

  private async changed(): Promise<void> {
    this.snapshots.clear();
    await this.deps.store.set(WIRE_KEY, JSON.stringify(this.state));
    [...this.listeners].forEach((cb) => cb());
  }

  // ── PEP: publicar ──

  /** Bundle y luego device list (un cliente estricto puede pedir el bundle al ver el aviso). */
  async publishOwn(): Promise<void> {
    await this.publishBundle();
    await this.fetchDevices(this.ownBare);
    await this.publishDevices();
  }

  private pubIq(node: string, itemId: string, payload: Element, maxItems: string | null): Element {
    return xml('iq', { type: 'set' },
      xml('pubsub', { xmlns: PUBSUB_NS },
        xml('publish', { node }, xml('item', { id: itemId }, payload)),
        ...(maxItems === null ? [] : [xml('publish-options', {},
          xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
            xml('field', { var: 'FORM_TYPE', type: 'hidden' },
              xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
            field('pubsub#max_items', maxItems),
            field('pubsub#access_model', 'open')))])));
  }

  /**
   * max_items igual que xat (devices 1, bundles 100): el servidor compara las
   * publish-options con la config del nodo que creó el primer cliente y, si no
   * coinciden, rechaza con precondition-not-met. En ese caso se publica sin
   * opciones y el item entra con la config existente del nodo.
   */
  private async publish(node: string, itemId: string, payload: Element, maxItems: string): Promise<void> {
    try {
      await this.deps.request(this.pubIq(node, itemId, payload, maxItems));
    } catch (e) {
      const app = (e as { application?: { name?: string } } | null)?.application;
      if (app?.name !== 'precondition-not-met') throw e;
      console.warn('[OMEMO2] publish-options no coinciden con el nodo', node, '— publico sin opciones');
      await this.deps.request(this.pubIq(node, itemId, payload, null));
    }
  }

  async publishBundle(): Promise<void> {
    const b = this.sm.bundle();
    await this.publish(NODE_BUNDLES, String(this.deviceId),
      xml('bundle', { xmlns: NS_OMEMO2 },
        xml('spk', { id: String(b.spkId) }, b64encode(b.spk)),
        xml('spks', {}, b64encode(b.spkSig)),
        xml('ik', {}, b64encode(b.ik)),
        xml('prekeys', {}, ...b.prekeys.map((p) => xml('pk', { id: String(p.id) }, b64encode(p.pub))))), '100');
  }

  /**
   * XEP-0384 §4.5: rota el signed prekey si tiene más de una semana y
   * republica el bundle. True si rotó. `now` inyectable para pruebas.
   */
  async rotateSpkIfStale(now = Date.now()): Promise<boolean> {
    if (!(await this.sm.rotateSignedPreKeyIfOlderThan(SPK_MAX_AGE_MS, now))) return false;
    await this.publishBundle();
    return true;
  }

  private async publishDevices(): Promise<void> {
    const ids = new Set([...(this.state.devices[this.ownBare] ?? []), this.deviceId]);
    await this.publish(NODE_DEVICES, 'current',
      xml('devices', { xmlns: NS_OMEMO2 }, ...[...ids].map((id) => xml('device', { id: String(id) }))), '1');
    this.state.devices[this.ownBare] = [...ids];
    await this.changed();
  }

  private async replenish(): Promise<void> {
    if (this.sm.bundle().prekeys.length >= PREKEY_MIN) return;
    if (await this.sm.ensurePreKeys(PREKEY_TARGET)) await this.publishBundle();
  }

  // ── PEP: consumir ──

  private async fetchItems(jid: string, node: string, itemId?: string): Promise<Element[]> {
    const res = await this.deps.request(xml('iq', { type: 'get', to: jid },
      xml('pubsub', { xmlns: PUBSUB_NS },
        xml('items', { node }, ...(itemId ? [xml('item', { id: itemId })] : [])))));
    return res.getChild('pubsub')?.getChild('items')?.getChildren('item') ?? [];
  }

  private static parseDevices(devices: Element | undefined): number[] | null {
    if (!devices) return null;
    return devices.getChildren('device').map((d) => parseInt(d.attrs.id, 10)).filter((n) => Number.isInteger(n) && n > 0);
  }

  /** Pide la device list actual del contacto y la guarda. Lista vacía si no publicó una. */
  async fetchDevices(jid: string): Promise<number[]> {
    const bare = bareJid(jid);
    let ids: number[] = [];
    try {
      const items = await this.fetchItems(bare, NODE_DEVICES);
      ids = items.map((i) => Omemo2Engine.parseDevices(i.getChild('devices'))).find((l) => l) ?? [];
    } catch (e) {
      // Sólo "no hay lista" cuenta como vacía; un timeout se propaga (si no, publishOwn pisaría la lista propia).
      const c = (e as { condition?: string }).condition;
      if (!c || !NO_LIST.includes(c)) throw e;
    }
    this.state.devices[bare] = ids;
    await this.changed();
    return ids;
  }

  /** Evento PEP de device list. True si la stanza era de este nodo (consumida). */
  async handleDevicesEvent(stanza: Element): Promise<boolean> {
    const items = stanza.getChild('event', PUBSUB_EVENT_NS)?.getChild('items');
    if (items?.attrs.node !== NODE_DEVICES) return false;
    const from = stanza.attrs.from;
    if (!from) return true;
    const bare = bareJid(from);
    const ids = items.getChildren('item').map((i) => Omemo2Engine.parseDevices(i.getChild('devices'))).find((l) => l);
    if (!ids) return true; // retract/purge: se conserva lo que sabíamos
    this.state.devices[bare] = ids;
    await this.changed();
    // Otro cliente pisó la lista y nos quitó: nos volvemos a anunciar.
    if (bare === this.ownBare && !ids.includes(this.deviceId)) await this.publishDevices().catch(() => {});
    return true;
  }

  private async fetchBundle(dev: DeviceRef): Promise<Bundle | null> {
    try {
      const item = (await this.fetchItems(dev.jid, NODE_BUNDLES, String(dev.rid)))[0];
      const b = item?.getChild('bundle');
      const spk = b?.getChild('spk');
      if (!b || !spk) return null;
      const text = (name: string) => b.getChild(name)?.text() ?? '';
      return {
        ik: b64decode(text('ik')),
        spkId: parseInt(spk.attrs.id, 10),
        spk: b64decode(spk.text()),
        spkSig: b64decode(text('spks')),
        prekeys: (b.getChild('prekeys')?.getChildren('pk') ?? []).map((p) => ({
          id: parseInt(p.attrs.id, 10),
          pub: b64decode(p.text()),
        })),
      };
    } catch {
      return null;
    }
  }

  // ── Confianza ──

  private btbvDefault(jid: string): TrustState {
    const verified = Object.entries(this.state.trust).some(([k, t]) => k.startsWith(`${jid}:`) && t.trusted === 'verified');
    return verified ? 'distrusted' : 'blind';
  }

  /** Registra la identidad de un dispositivo visto por primera vez. Devuelve su confianza. */
  private async noteIdentity(dev: DeviceRef, ik: Uint8Array): Promise<TrustState> {
    const k = tk(dev.jid, dev.rid);
    const known = this.state.trust[k];
    if (known) return known.trusted;
    const trusted = this.btbvDefault(dev.jid);
    this.state.trust[k] = { identity: bytesToHex(ik), trusted };
    await this.changed();
    return trusted;
  }

  private reportIdentityChange(dev: DeviceRef, newIk: Uint8Array | null) {
    const newIdentity = newIk ? bytesToHex(newIk) : null;
    const dedupe = `${tk(dev.jid, dev.rid)}:${newIdentity}`;
    if (this.reported.has(dedupe)) return;
    this.reported.add(dedupe);
    const change = { ...dev, oldIdentity: this.state.trust[tk(dev.jid, dev.rid)]?.identity ?? null, newIdentity };
    [...this.identityListeners].forEach((cb) => cb(change));
  }

  // ── Salida ──

  /** Dispositivos del contacto; consulta la device list si aún no la conocemos. */
  private async peerDevices(jid: string): Promise<number[]> {
    return this.state.devices[jid] ?? this.fetchDevices(jid);
  }

  /** True si el contacto publica dispositivos OMEMO 2 y el cifrado está activo para él. */
  async canEncryptTo(jid: string): Promise<boolean> {
    const bare = bareJid(jid);
    return this.isEnabledFor(bare) && (await this.peerDevices(bare)).length > 0;
  }

  /** True si el cifrado está activo para `room` y algún peer publica dispositivos OMEMO 2. */
  async canEncryptGroup(room: string, peers: string[]): Promise<boolean> {
    if (!this.isEnabledFor(room)) return false;
    const lists = await Promise.all(peers.filter((j) => j !== this.ownBare).map((j) => this.peerDevices(j).catch(() => [])));
    return lists.some((l) => l.length > 0);
  }

  private async ensureSession(dev: DeviceRef): Promise<boolean> {
    const t = this.state.trust[tk(dev.jid, dev.rid)];
    if (t?.trusted === 'distrusted') return false;
    if (await this.sm.hasSession(dev)) return true;
    const bundle = await this.fetchBundle(dev);
    if (!bundle || bundle.prekeys.length === 0) return false;
    if (t && t.identity !== bytesToHex(bundle.ik)) {
      this.reportIdentityChange(dev, bundle.ik);
      return false;
    }
    try {
      await this.sm.createSessionFromBundle(dev, bundle);
    } catch {
      return false; // firma de spk inválida, etc.
    }
    if (await this.noteIdentity(dev, bundle.ik) === 'distrusted') return false;
    return true;
  }

  private encryptedElement(msg: EncryptedMessage, withPayload: boolean): Element {
    const byJid = new Map<string, EncryptedMessage['keys']>();
    for (const k of msg.keys) byJid.set(k.jid, [...(byJid.get(k.jid) ?? []), k]);
    return xml('encrypted', { xmlns: NS_OMEMO2 },
      xml('header', { sid: String(this.deviceId) },
        ...[...byJid].map(([jid, ks]) => xml('keys', { jid },
          ...ks.map((k) => xml('key', { rid: String(k.rid), ...(k.kex ? { kex: 'true' } : {}) }, b64encode(k.data)))))),
      ...(withPayload ? [xml('payload', {}, b64encode(msg.payload))] : []));
  }

  /**
   * Cifra `body` para los dispositivos de `peers` (+ nuestros otros dispositivos)
   * en UN <encrypted>. `skipped` = peers sin dispositivos OMEMO 2 o sin ninguno
   * utilizable. null si ningún peer tiene dispositivos; lanza si los tienen pero
   * con ninguno se pudo cifrar. `envTo` es el `to` del envelope SCE.
   */
  private async encryptFor(peers: string[], envTo: string, id: string, body: string, tolerant: boolean) {
    const withDevices: string[] = [];
    const skipped: string[] = [];
    for (const peer of peers) {
      // En sala un peer con la device list inaccesible se reporta, no aborta el envío.
      const ids = await this.peerDevices(peer).catch((e) => { if (!tolerant) throw e; return []; });
      (ids.length ? withDevices : skipped).push(peer);
    }
    if (!withDevices.length) return null;
    const targets: DeviceRef[] = [
      ...withDevices.flatMap((jid) => this.state.devices[jid].map((rid) => ({ jid, rid }))),
      ...(this.state.devices[this.ownBare] ?? []).filter((rid) => rid !== this.deviceId).map((rid) => ({ jid: this.ownBare, rid })),
    ];
    const ready: DeviceRef[] = [];
    for (const dev of targets) if (await this.ensureSession(dev)) ready.push(dev);
    const usable = withDevices.filter((jid) => ready.some((d) => d.jid === jid));
    if (!usable.length) throw new Error(`omemo2: sin dispositivos utilizables para ${withDevices.join(', ')}`);
    skipped.push(...withDevices.filter((jid) => !usable.includes(jid)));
    const msg = await this.sm.encryptForDevices(ready, buildEnvelope(body, { to: envTo, from: this.ownBare }));
    await Promise.all(ready.map((d) => this.kt.reset(d)));
    await this.deps.store.set(plainKey(envTo, this.ownBare, id), body); // la copia MAM propia no lleva clave para este dispositivo
    const children = [
      this.encryptedElement(msg, true),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: NS_OMEMO2, name: 'OMEMO 2' }),
      xml('body', {}, OMEMO2_FALLBACK_BODY),
      xml('store', { xmlns: 'urn:xmpp:hints' }),
    ];
    return { children, skipped };
  }

  /**
   * Hijos de <message> para un mensaje 1:1 cifrado (encrypted + EME + body de
   * respaldo + hint store), o null si OMEMO 2 no aplica (desactivado para el
   * contacto o sin dispositivos OMEMO 2): el llamador cae a legacy/texto plano.
   * Lanza si el contacto tiene dispositivos pero con ninguno se pudo cifrar.
   */
  async encryptOutgoing(to: string, id: string, body: string): Promise<Element[] | null> {
    const peer = bareJid(to);
    if (!(await this.canEncryptTo(peer))) return null;
    return (await this.encryptFor([peer], peer, id, body, false))!.children;
  }

  /**
   * Igual para una sala (XEP-0384 §7): `recipients` son los bare JIDs reales de
   * sus miembros y el envelope SCE lleva la sala como `to`. `skipped` lista los
   * que quedaron sin clave (sin OMEMO 2 o sin dispositivo utilizable).
   */
  async encryptOutgoingGroup(room: string, recipients: string[], id: string, body: string): Promise<{ children: Element[]; skipped: string[] } | null> {
    if (!this.isEnabledFor(room)) return null;
    const peers = [...new Set(recipients.map(bareJid))].filter((j) => j !== this.ownBare);
    return this.encryptFor(peers, bareJid(room), id, body, true);
  }

  private async sendKeyTransport(dev: DeviceRef): Promise<void> {
    const msg = await this.sm.encryptForDevices([dev], buildEnvelope('', { to: dev.jid, from: this.ownBare }));
    await this.kt.reset(dev);
    await this.deps.send(xml('message', { type: 'chat', to: dev.jid },
      this.encryptedElement(msg, false), xml('store', { xmlns: 'urn:xmpp:hints' })));
  }

  // ── Entrada ──

  /**
   * Descifra el <encrypted> de `stanza` (mensaje en vivo, carbon o MAM).
   * `senderJid` es el remitente real de la stanza (el propio JID en copias
   * salientes). `live` = cuenta para el key transport (falso en MAM).
   * `expectedTo` = destinatario esperado del envelope SCE (la sala en groupchat;
   * nosotros, o el contacto en una copia propia, en 1:1). En sala el <to> es
   * obligatorio; en 1:1 si falta se acepta (clientes propios no siempre lo ponen).
   */
  async decrypt(stanza: Element, senderJid: string, live = true, expectedTo?: string): Promise<Omemo2Result> {
    const bad = (why: string): Omemo2Result => ({ body: `🔒 [OMEMO 2: ${why}]`, status: 'undecryptable' });
    const enc = stanza.getChild('encrypted', NS_OMEMO2);
    const header = enc?.getChild('header');
    const sid = parseInt(header?.attrs.sid ?? '', 10);
    if (!enc || !header || !Number.isInteger(sid)) return bad('mensaje malformado');
    const payloadText = enc.getChild('payload')?.text();
    const payload = payloadText ? b64decode(payloadText) : undefined;
    const mine = header.getChildren('keys').find((k) => k.attrs.jid === this.ownBare)
      ?.getChildren('key').find((k) => parseInt(k.attrs.rid, 10) === this.deviceId);
    const quiet = (why: string) => (payload ? bad(why) : { body: '', status: 'undecryptable' as const });
    const dev: DeviceRef = { jid: bareJid(senderJid), rid: sid };
    const id = stanza.attrs.id;
    const group = stanza.attrs.type === 'groupchat';
    const conv = (group || dev.jid === this.ownBare ? expectedTo : dev.jid) ?? dev.jid;
    const cachedPlain = async () => {
      if (!id) return null;
      return (await this.deps.store.get(plainKey(conv, dev.jid, id))) ?? this.deps.store.get(legacyPlainKey(dev.jid, id));
    };
    if (!mine) {
      console.warn('[OMEMO2] sin clave para este dispositivo', this.deviceId, 'de', dev.jid, dev.rid, 'rids:',
        header.getChildren('keys').map((k) => `${k.attrs.jid}:${k.getChildren('key').map((x) => x.attrs.rid).join(',')}`).join(' '));
      // Típico en MAM: la copia de lo que enviamos desde este dispositivo no lleva clave para él.
      const cached = await cachedPlain();
      return cached !== null ? { body: cached, status: 'omemo2' } : quiet('no descifrable en este dispositivo');
    }
    const trust = this.state.trust[tk(dev.jid, dev.rid)];
    if (trust?.trusted === 'distrusted') return quiet('dispositivo no confiable');
    const key = { kex: mine.attrs.kex === 'true' || mine.attrs.kex === '1', data: b64decode(mine.text()) };

    let res: { plaintext: Uint8Array | null; peerIk: Uint8Array };
    try {
      res = await this.sm.decryptFromDevice(dev, key, payload, trust ? hexToBytes(trust.identity) : undefined);
    } catch (e) {
      if (e instanceof Error && e.message.includes('identity key')) {
        let ik: Uint8Array | null = null;
        try { ik = key.kex ? decodeKeyExchange(key.data).ik : null; } catch { /* kex ilegible */ }
        this.reportIdentityChange(dev, ik);
        return quiet('la identidad del dispositivo cambió');
      }
      const cached = await cachedPlain();
      if (cached !== null) return { body: cached, status: 'omemo2' };
      return quiet('error al descifrar');
    }

    if (await this.noteIdentity(dev, res.peerIk) === 'distrusted') {
      if (id && res.plaintext) await this.deps.store.set(plainKey(conv, dev.jid, id), parseEnvelope(res.plaintext).body ?? '');
      return quiet('dispositivo nuevo sin confianza');
    }
    await this.replenish().catch((e) => console.warn('[OMEMO2] replenish failed', e));

    if (!res.plaintext) return { body: '', status: 'omemo2' }; // key transport
    const env = parseEnvelope(res.plaintext);
    if (env.from !== undefined && bareJid(env.from) !== dev.jid) return bad('remitente no coincide');
    if (group ? env.to === undefined || bareJid(env.to) !== expectedTo : env.to !== undefined && expectedTo !== undefined && bareJid(env.to) !== expectedTo) {
      return bad('destinatario no coincide');
    }
    const body = env.body ?? '';
    if (id) await this.deps.store.set(plainKey(conv, dev.jid, id), body);

    if (live) {
      const n = await this.kt.increment(dev);
      if (n >= KEY_TRANSPORT_AFTER) await this.sendKeyTransport(dev).catch((e) => console.warn('[OMEMO2] key transport failed', e));
    }
    return { body, status: 'omemo2' };
  }
}

// ── Singleton ligado a la conexión ──

let engine: Omemo2Engine | null = null;
let creating: Promise<Omemo2Engine> | null = null;
const listeners = new Set<() => void>();
const identityListeners = new Set<(c: IdentityChange) => void>();

function requireClient() {
  const client = usableClient();
  if (!client) throw new Error('XMPP not connected');
  return client;
}

/** Crea el motor (una vez por cuenta) y publica bundle + device list. Llamar al quedar en línea. */
export async function startOmemo2(jid: string): Promise<void> {
  if (!engine || engine.ownBare !== bareJid(jid)) {
    creating ??= (async () => {
      const e = await Omemo2Engine.create({
        jid,
        store: new SqliteOmemoStore(),
        request: (iq) => requireClient().iqCaller.request(iq, 15000),
        send: (s) => requireClient().send(s),
      });
      e.subscribe(() => [...listeners].forEach((cb) => cb()));
      e.onIdentityChanged((c) => [...identityListeners].forEach((cb) => cb(c)));
      return e;
    })().finally(() => { creating = null; });
    engine = await creating;
    listeners.forEach((cb) => cb());
  }
  // Rotación semanal del signed prekey (XEP-0384 §4.5); publishOwn republica
  // el bundle con el spk nuevo. Un fallo acá no debe impedir arrancar OMEMO.
  await engine.rotateSpkIfStale().catch((e) => console.warn('[OMEMO2] spk rotation failed', e));
  await engine.publishOwn();
  console.warn('[OMEMO2] publicado: dispositivo', engine.deviceId, 'de', engine.ownBare);
}

export function getOmemo2(): Omemo2Engine | null {
  return engine;
}

/** Sólo para tests. */
export function setOmemo2ForTest(e: Omemo2Engine | null) {
  engine = e;
}

const NO_DEVICES: Omemo2Device[] = [];
const NO_CHANGES: IdentityChange[] = [];

// Cambios de identity key pendientes de revisión, por JID; la referencia sólo cambia al mutar (useSyncExternalStore).
const pendingChanges = new Map<string, IdentityChange[]>();
const changeListeners = new Set<() => void>();
const notifyChanges = () => [...changeListeners].forEach((cb) => cb());
identityListeners.add((c) => {
  const bare = bareJid(c.jid);
  pendingChanges.set(bare, [...(pendingChanges.get(bare) ?? []).filter((x) => x.rid !== c.rid), c]);
  notifyChanges();
});

async function setTrustAndClear(jid: string, rid: number, state: TrustState, identity?: string): Promise<boolean> {
  const ok = engine ? await engine.setTrust(jid, rid, state, identity) : false;
  const bare = bareJid(jid);
  const prev = pendingChanges.get(bare) ?? [];
  const left = prev.filter((x) => x.rid !== rid);
  if (ok && left.length !== prev.length) {
    if (left.length) pendingChanges.set(bare, left);
    else pendingChanges.delete(bare);
    notifyChanges();
  }
  return ok;
}

/** Fachada pública (XmppService.omemo2). */
export const omemo2Api = {
  get ownFingerprint(): string | null {
    return engine?.ownFingerprint ?? null;
  },
  devices: (jid: string): Omemo2Device[] => engine?.devices(jid) ?? NO_DEVICES,
  setTrust: setTrustAndClear,
  /** JID propio (bare) del motor, o null si OMEMO 2 no está iniciado. */
  get ownJid(): string | null {
    return engine?.ownBare ?? null;
  },
  /** Cambios de identity key sin revisar de `jid`; se limpian al fijar la confianza del dispositivo. */
  identityChanges: (jid: string): IdentityChange[] => pendingChanges.get(bareJid(jid)) ?? NO_CHANGES,
  subscribeChanges(cb: () => void): () => void {
    changeListeners.add(cb);
    return () => changeListeners.delete(cb);
  },
  isEnabledFor: (jid: string): boolean => engine?.isEnabledFor(jid) ?? true,
  setEnabledFor: (jid: string, enabled: boolean) => engine?.setEnabledFor(jid, enabled) ?? Promise.resolve(),
  /** Vuelve a pedir la device list del contacto (p. ej. al abrir su chat). */
  refresh: (jid: string) => engine?.fetchDevices(jid).then(() => undefined).catch(() => undefined) ?? Promise.resolve(),
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  onIdentityChanged(cb: (c: IdentityChange) => void): () => void {
    identityListeners.add(cb);
    return () => identityListeners.delete(cb);
  },
};

/** Gancho del router: eventos PEP de device list OMEMO 2. True si consumió la stanza. */
export function handleOmemo2Event(stanza: Element): boolean {
  const items = stanza.getChild('event', PUBSUB_EVENT_NS)?.getChild('items');
  if (items?.attrs.node !== NODE_DEVICES) return false;
  void engine?.handleDevicesEvent(stanza).catch(() => {});
  return true;
}
