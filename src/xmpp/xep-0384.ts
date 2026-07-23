import { NativeModules } from 'react-native';
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import * as SecureStore from 'expo-secure-store';

const getXmppOmemoModule = () => NativeModules.XmppOmemoModule;

export interface OmemoPreKey {
  id: number;
  publicKey: string; // base64
}

export interface OmemoSignedPreKey {
  id: number;
  publicKey: string; // base64
  signature: string; // base64
  timestamp: number;
}

export interface OmemoBundle {
  registrationId: number;
  deviceId: number;
  preKeyId?: number;
  preKeyPublic?: string; // base64
  signedPreKeyId: number;
  signedPreKeyPublic: string; // base64
  signedPreKeySignature: string; // base64
  identityKey: string; // base64
}

export interface OmemoState {
  sessionFormatVersion?: number;
  deviceId: number;
  registrationId: number;
  identityPublicKey: string; // base64
  signedPreKey: OmemoSignedPreKey;
  preKeys: OmemoPreKey[];
}

const DEVICE_LIST_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SECURE_STATE_CHUNK_SIZE = 1800;
const SESSION_FORMAT_VERSION = 2;

class OmemoService {
  private activeJid: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private xmppClient: any = null;
  private deviceId: number = 0;
  private registrationId: number = 0;
  private identityPublicKey: string = '';
  private signedPreKey: OmemoSignedPreKey | null = null;
  private preKeys: OmemoPreKey[] = [];
  private omemoEnabled: boolean = false;
  private initPromise: Promise<void> | null = null;
  private cryptoTail: Promise<void> = Promise.resolve();

  // Cache: contactBareJid -> { devices: number[], expiresAt: number }
  private deviceListCache = new Map<string, { devices: number[]; expiresAt: number }>();

  // Room JID -> Set of real occupant JIDs
  private mucOccupants = new Map<string, Set<string>>();

  constructor() {
    // If running in Jest, we can mock XmppOmemoModule
    if (!getXmppOmemoModule()) {
      // eslint-disable-next-line no-console
      console.warn('[OMEMO] Native XmppOmemoModule not loaded. Running in mock mode.');
    }
  }

  isSupported(): boolean {
    return !!getXmppOmemoModule();
  }

  isEnabled(): boolean {
    return this.omemoEnabled;
  }

  getDeviceId(): number {
    return this.deviceId;
  }

  getRegistrationId(): number {
    return this.registrationId;
  }

  registerMucOccupant(roomJid: string, realJid: string) {
    const room = roomJid.split('/')[0];
    const occupants = this.mucOccupants.get(room) ?? new Set<string>();
    occupants.add(realJid.split('/')[0]);
    this.mucOccupants.set(room, occupants);
  }

  removeMucOccupant(roomJid: string, realJid: string) {
    const room = roomJid.split('/')[0];
    const occupants = this.mucOccupants.get(room);
    if (occupants) {
      occupants.delete(realJid.split('/')[0]);
    }
  }

  clearMucOccupants(roomJid: string) {
    this.mucOccupants.delete(roomJid.split('/')[0]);
  }

  private bareJid(jid: string): string {
    return jid.split('/')[0];
  }

  private stateKey(jid: string): string {
    return `gtk_llm_chat.omemo.${jid.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  }

  private async readSecureState(key: string): Promise<string | null> {
    const partsRaw = await SecureStore.getItemAsync(`${key}.parts`, { requireAuthentication: false });
    if (!partsRaw) {
      // One-time migration from the first OMEMO build, which stored the whole
      // JSON value under a single SecureStore key.
      return SecureStore.getItemAsync(key, { requireAuthentication: false });
    }
    const partCount = Number(partsRaw);
    if (!Number.isInteger(partCount) || partCount < 1) return null;
    const parts = await Promise.all(Array.from({ length: partCount }, (_, index) =>
      SecureStore.getItemAsync(`${key}.${index}`, { requireAuthentication: false })));
    if (parts.some((part) => part === null)) {
      throw new Error('OMEMO secure state is incomplete');
    }
    return parts.join('');
  }

  private async writeSecureState(key: string, value: string): Promise<void> {
    const previousCount = Number(await SecureStore.getItemAsync(`${key}.parts`, {
      requireAuthentication: false,
    })) || 0;
    const parts = value.match(new RegExp(`.{1,${SECURE_STATE_CHUNK_SIZE}}`, 'gs')) ?? [''];
    const options = {
      requireAuthentication: false,
      keychainAccessible: SecureStore.ALWAYS,
    };
    await Promise.all(parts.map((part, index) =>
      SecureStore.setItemAsync(`${key}.${index}`, part, options)));
    await SecureStore.setItemAsync(`${key}.parts`, String(parts.length), options);
    await SecureStore.deleteItemAsync(key);
    await Promise.all(Array.from(
      { length: Math.max(0, previousCount - parts.length) },
      (_, offset) => SecureStore.deleteItemAsync(`${key}.${parts.length + offset}`),
    ));
  }

  private async serializedCrypto<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.cryptoTail;
    let release!: () => void;
    this.cryptoTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  init(jid: string, xmppClient: any, omemoEnabled: boolean): Promise<void> {
    this.initPromise = this.initInternal(jid, xmppClient, omemoEnabled);
    return this.initPromise;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async initInternal(jid: string, xmppClient: any, omemoEnabled: boolean): Promise<void> {
    this.activeJid = this.bareJid(jid);
    this.xmppClient = xmppClient;
    this.omemoEnabled = omemoEnabled;

    if (!omemoEnabled) {
      // eslint-disable-next-line no-console
      console.log('[OMEMO] OMEMO is disabled for this account.');
      return;
    }

    const nativeMod = getXmppOmemoModule();
    if (!nativeMod) {
      // eslint-disable-next-line no-console
      console.error('[OMEMO] Cannot initialize. Native module not available.');
      return;
    }

    const stateKey = this.stateKey(this.activeJid);
    let loadedState: OmemoState | null = null;

    try {
      const content = await this.readSecureState(stateKey);
      if (content) {
        loadedState = JSON.parse(content);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[OMEMO] Failed to load existing state. Generating new keys...', e);
    }

    if (loadedState && loadedState.deviceId && loadedState.registrationId) {
      // eslint-disable-next-line no-console
      console.log('[OMEMO] Loading existing OMEMO state for', this.activeJid);
      this.deviceId = loadedState.deviceId;
      this.registrationId = loadedState.registrationId;
      this.identityPublicKey = loadedState.identityPublicKey;
      this.signedPreKey = loadedState.signedPreKey;
      this.preKeys = loadedState.preKeys;

      // Re-initialize native module state
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await nativeMod.deserialize((loadedState as any).nativeState);
      if (loadedState.sessionFormatVersion !== SESSION_FORMAT_VERSION) {
        // Versions before 2 could create Signal sessions without the legacy
        // one-time prekey because `<prekeys>` was parsed with the wrong case.
        // Those sessions must not be reused after fixing bundle parsing.
        // eslint-disable-next-line no-console
        console.log('[OMEMO] Resetting legacy sessions created with incomplete bundles');
        await nativeMod.resetSessions();
        await this.saveState();
      }
    } else {
      // eslint-disable-next-line no-console
      console.log('[OMEMO] Initializing fresh OMEMO state for', this.activeJid);
      this.deviceId = Math.floor(Math.random() * 2147483646) + 1;
      this.registrationId = Math.floor(Math.random() * 16382) + 1;

      // Generate local cryptographic parameters
      const identityKeyPair = await nativeMod.generateIdentityKeyPair();
      this.identityPublicKey = identityKeyPair.publicKey;

      const preKeys = await nativeMod.generatePreKeys(100);
      this.preKeys = preKeys;

      const signedPreKey = await nativeMod.generateSignedPreKey(null, 1);
      this.signedPreKey = signedPreKey;

      await this.saveState();
    }

    // Do not pin our own list to this device only: the server-side list also
    // contains Gajim/Dino/other Android installations needed for sent carbons.
    this.deviceListCache.delete(this.activeJid);
  }

  async saveState(): Promise<void> {
    const nativeMod = getXmppOmemoModule();
    if (!this.activeJid || !nativeMod) return;
    const stateKey = this.stateKey(this.activeJid);
    try {
      const nativeState = await nativeMod.serialize();
      const stateToSave = {
        sessionFormatVersion: SESSION_FORMAT_VERSION,
        deviceId: this.deviceId,
        registrationId: this.registrationId,
        identityPublicKey: this.identityPublicKey,
        signedPreKey: this.signedPreKey,
        preKeys: this.preKeys,
        nativeState,
      };
      await this.writeSecureState(stateKey, JSON.stringify(stateToSave));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[OMEMO] Failed to save OMEMO state', e);
      throw e;
    }
  }

  async fetchDeviceList(jid: string, force = false): Promise<number[]> {
    const bare = this.bareJid(jid);
    if (!force) {
      const cached = this.deviceListCache.get(bare);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.devices;
      }
    }

    if (!this.xmppClient) return [];

    // eslint-disable-next-line no-console
    console.log('[OMEMO] Fetching device list for', bare);
    try {
      const result = await this.xmppClient.iqCaller.request(
        xml('iq', { type: 'get', to: bare },
          xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
            xml('items', { node: 'eu.siacs.conversations.axolotl.devicelist' })
          )
        ),
        15000
      );

      const item = result
        .getChild('pubsub', 'http://jabber.org/protocol/pubsub')
        ?.getChild('items')
        ?.getChild('item');

      let devices: number[] = [];
      if (item) {
        const listNode = item.getChild('list', 'eu.siacs.conversations.axolotl');
        if (listNode) {
          devices = listNode
            .getChildren('device')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((d: any) => parseInt(d.attrs.id, 10))
            .filter((id: number) => !isNaN(id));
        }
      }

      this.deviceListCache.set(bare, {
        devices,
        expiresAt: Date.now() + DEVICE_LIST_TTL_MS,
      });

      return devices;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[OMEMO] Failed to fetch device list for', bare, e);
      // Return empty array or cached
      return this.deviceListCache.get(bare)?.devices ?? [];
    }
  }

  handleDeviceListUpdate(jid: string, devices: number[]): void {
    const bare = this.bareJid(jid);
    // eslint-disable-next-line no-console
    console.log('[OMEMO] Device list update for', bare, devices);

    this.deviceListCache.set(bare, {
      devices,
      expiresAt: Date.now() + DEVICE_LIST_TTL_MS,
    });
  }

  async fetchBundle(jid: string, devId: number): Promise<OmemoBundle | null> {
    const bare = this.bareJid(jid);
    if (!this.xmppClient) return null;

    // eslint-disable-next-line no-console
    console.log('[OMEMO] Fetching bundle for', bare, 'device', devId);
    try {
      const result = await this.xmppClient.iqCaller.request(
        xml('iq', { type: 'get', to: bare },
          xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
            xml('items', { node: `eu.siacs.conversations.axolotl.bundles:${devId}` })
          )
        ),
        15000
      );

      const item = result
        .getChild('pubsub', 'http://jabber.org/protocol/pubsub')
        ?.getChild('items')
        ?.getChild('item');
      if (!item) return null;

      const bundleNode = item.getChild('bundle', 'eu.siacs.conversations.axolotl');
      if (!bundleNode) return null;

      const registrationIdNode = bundleNode.getChild('registrationId');
      // Legacy OMEMO bundles do not publish a separate Signal registration
      // id. Implementations use the advertised OMEMO device id here.
      const registrationId = registrationIdNode ? parseInt(registrationIdNode.text(), 10) : devId;

      const signedPreKeyPublicNode = bundleNode.getChild('signedPreKeyPublic');
      const signedPreKeyId = signedPreKeyPublicNode ? parseInt(signedPreKeyPublicNode.attrs.signedPreKeyId, 10) : 0;
      const signedPreKeyPublic = signedPreKeyPublicNode ? signedPreKeyPublicNode.text().trim() : '';

      const signedPreKeySignatureNode = bundleNode.getChild('signedPreKeySignature');
      const signedPreKeySignature = signedPreKeySignatureNode ? signedPreKeySignatureNode.text().trim() : '';

      const identityKeyNode = bundleNode.getChild('identityKey');
      const identityKey = identityKeyNode ? identityKeyNode.text().trim() : '';

      // XEP-0384 legacy spells the container `<prekeys>` (lowercase k).
      // Accept the mixed-case spelling too for compatibility with older
      // gtk-llm-chat-android bundles, but never publish it ourselves.
      const preKeysNode = bundleNode.getChild('prekeys') ?? bundleNode.getChild('preKeys');
      const preKeyList = preKeysNode ? preKeysNode.getChildren('preKeyPublic') : [];
      let preKeyId: number | undefined;
      let preKeyPublic: string | undefined;

      if (preKeyList.length > 0) {
        const selected = preKeyList[Math.floor(Math.random() * preKeyList.length)];
        preKeyId = parseInt(selected.attrs.preKeyId, 10);
        preKeyPublic = selected.text().trim();
      }

      if (!Number.isInteger(preKeyId) || !preKeyPublic ||
          !Number.isInteger(signedPreKeyId) || !signedPreKeyPublic ||
          !signedPreKeySignature || !identityKey) {
        // A session without a one-time prekey produces a PreKeySignalMessage
        // that strict clients such as Gajim reject as malformed.
        // eslint-disable-next-line no-console
        console.warn('[OMEMO] Incomplete legacy bundle for', bare, devId);
        return null;
      }
      // eslint-disable-next-line no-console
      console.log(`[OMEMO] Selected legacy prekey ${preKeyId} for ${bare}:${devId}`);

      return {
        registrationId,
        deviceId: devId,
        preKeyId,
        preKeyPublic,
        signedPreKeyId,
        signedPreKeyPublic,
        signedPreKeySignature,
        identityKey,
      };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[OMEMO] Failed to fetch bundle for', bare, 'device', devId, e);
      return null;
    }
  }

  async publishDeviceList(): Promise<void> {
    if (!this.xmppClient || !this.deviceId) return;

    // eslint-disable-next-line no-console
    console.log('[OMEMO] Publishing device list to PEP...');
    let currentDevices: number[] = [];
    try {
      const result = await this.xmppClient.iqCaller.request(
        xml('iq', { type: 'get' },
          xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
            xml('items', { node: 'eu.siacs.conversations.axolotl.devicelist' })
          )
        ),
        10000
      );
      const item = result
        .getChild('pubsub', 'http://jabber.org/protocol/pubsub')
        ?.getChild('items')
        ?.getChild('item');
      if (item) {
        const listNode = item.getChild('list', 'eu.siacs.conversations.axolotl');
        if (listNode) {
          currentDevices = listNode
            .getChildren('device')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((d: any) => parseInt(d.attrs.id, 10))
            .filter((id: number) => !isNaN(id));
        }
      }
    } catch {
      // Node probably doesn't exist yet, start fresh
    }

    if (!currentDevices.includes(this.deviceId)) {
      currentDevices.push(this.deviceId);
    }

    await this.xmppClient.iqCaller.request(
      xml('iq', { type: 'set' },
        xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
          xml('publish', { node: 'eu.siacs.conversations.axolotl.devicelist' },
            xml('item', {},
              xml('list', { xmlns: 'eu.siacs.conversations.axolotl' },
                ...currentDevices.map(id => xml('device', { id: String(id) }))
              )
            )
          )
        )
      ),
      15000
    );
    // eslint-disable-next-line no-console
    console.log('[OMEMO] Device list published.');
  }

  async removeOwnDevice(): Promise<void> {
    if (!this.xmppClient || !this.activeJid) return;
    let ownDeviceId = this.deviceId;
    if (!ownDeviceId) {
      const content = await this.readSecureState(this.stateKey(this.activeJid));
      if (content) ownDeviceId = Number((JSON.parse(content) as OmemoState).deviceId);
    }
    if (!ownDeviceId) return;

    let currentDevices: number[] = [];
    try {
      const result = await this.xmppClient.iqCaller.request(
        xml('iq', { type: 'get' },
          xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
            xml('items', { node: 'eu.siacs.conversations.axolotl.devicelist' }))),
        10000,
      );
      const list = result
        .getChild('pubsub', 'http://jabber.org/protocol/pubsub')
        ?.getChild('items')
        ?.getChild('item')
        ?.getChild('list', 'eu.siacs.conversations.axolotl');
      currentDevices = (list?.getChildren('device') ?? [])
        .map((device: Element) => Number(device.attrs.id))
        .filter((id: number) => Number.isInteger(id) && id !== ownDeviceId);
    } catch (error) {
      // Never replace an unreadable list with an empty one: that would remove
      // Gajim/Dino and every other own device along with this installation.
      // eslint-disable-next-line no-console
      console.warn('[OMEMO] Could not read device list while disabling', error);
      return;
    }

    await this.xmppClient.iqCaller.request(
      xml('iq', { type: 'set' },
        xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
          xml('publish', { node: 'eu.siacs.conversations.axolotl.devicelist' },
            xml('item', {},
              xml('list', { xmlns: 'eu.siacs.conversations.axolotl' },
                ...currentDevices.map(id => xml('device', { id: String(id) }))))))),
      15000,
    );
    this.deviceListCache.delete(this.activeJid);
    // eslint-disable-next-line no-console
    console.log('[OMEMO] Device removed from published legacy device list.');
  }

  async publishBundle(): Promise<void> {
    if (!this.xmppClient || !this.deviceId || !this.signedPreKey) return;

    // eslint-disable-next-line no-console
    console.log('[OMEMO] Publishing bundle to PEP...');
    await this.xmppClient.iqCaller.request(
      xml('iq', { type: 'set' },
        xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
          xml('publish', { node: `eu.siacs.conversations.axolotl.bundles:${this.deviceId}` },
            xml('item', {},
              xml('bundle', { xmlns: 'eu.siacs.conversations.axolotl' },
                xml('signedPreKeyPublic', { signedPreKeyId: String(this.signedPreKey.id) }, this.signedPreKey.publicKey),
                xml('signedPreKeySignature', { signedPreKeyId: String(this.signedPreKey.id) }, this.signedPreKey.signature),
                xml('identityKey', {}, this.identityPublicKey),
                xml('prekeys', {},
                  ...this.preKeys.map(pk => xml('preKeyPublic', { preKeyId: String(pk.id) }, pk.publicKey))
                )
              )
            )
          )
        )
      ),
      15000
    );
    // eslint-disable-next-line no-console
    console.log('[OMEMO] Bundle published.');
  }

  async getOrCreateSession(jid: string, devId: number): Promise<boolean> {
    const bare = this.bareJid(jid);
    const nativeMod = getXmppOmemoModule();
    if (!nativeMod) return false;

    // Check if we already have this session locally
    const nativeStateStr = await nativeMod.serialize();
    const nativeState = JSON.parse(nativeStateStr);
    const sessions = nativeState.sessions || {};
    const key = `${bare}:${devId}`;

    if (sessions[key]) {
      return true;
    }

    // Fetch bundle and build session
    const bundle = await this.fetchBundle(bare, devId);
    if (!bundle) return false;

    try {
      await nativeMod.createSession(`${bare}:${devId}`, null, bundle);
      await this.saveState();
      return true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[OMEMO] Failed to build session with', bare, devId, e);
      return false;
    }
  }

  async encryptMessage(toJid: string, plaintext: string, isGroupChat = false): Promise<{ encryptedXml: Element | null; wasEncrypted: boolean }> {
    if (this.initPromise) {
      await this.initPromise;
    }
    return this.serializedCrypto(() => this.encryptMessageLocked(toJid, plaintext, isGroupChat));
  }

  private async encryptMessageLocked(toJid: string, plaintext: string, isGroupChat: boolean): Promise<{ encryptedXml: Element | null; wasEncrypted: boolean }> {
    const nativeMod = getXmppOmemoModule();
    if (!this.omemoEnabled || !nativeMod) {
      return { encryptedXml: null, wasEncrypted: false };
    }

    const bareTo = this.bareJid(toJid);
    let recipientJids: string[] = [];

    if (isGroupChat) {
      const occupants = this.mucOccupants.get(bareTo);
      if (!occupants || occupants.size === 0) {
        // eslint-disable-next-line no-console
        console.warn('[OMEMO] No occupants found for groupchat', bareTo, '- falling back to plaintext.');
        return { encryptedXml: null, wasEncrypted: false };
      }
      recipientJids = Array.from(occupants);
    } else {
      recipientJids = [bareTo];
    }

    // Always include our own bare JID so that our other devices can decrypt the message
    if (this.activeJid && !recipientJids.includes(this.activeJid)) {
      recipientJids.push(this.activeJid);
    }

    // 1. Gather all devices and ensure session exists for each (in parallel for high performance)
    const jidToDeviceList = new Map<string, number[]>();
    await Promise.all(recipientJids.map(async (jid) => {
      const devList = await this.fetchDeviceList(jid);
      jidToDeviceList.set(jid, devList);
      // Keep this visible in release logs while OMEMO interoperability is
      // being validated: it tells us which clients the server advertises.
      // eslint-disable-next-line no-console
      console.log(`[OMEMO] Legacy devices advertised by ${jid}:`, devList.join(',') || '(none)');
    }));

    const candidates: Array<{ jid: string; deviceId: number }> = [];
    for (const jid of recipientJids) {
      const devList = jidToDeviceList.get(jid) || [];
      for (const devId of devList) {
        if (jid === this.activeJid && devId === this.deviceId) {
          continue;
        }
        candidates.push({ jid, deviceId: devId });
      }
    }

    const devicesToEncrypt: Array<{ jid: string; deviceId: number }> = [];
    await Promise.all(candidates.map(async (cand) => {
      const ok = await this.getOrCreateSession(cand.jid, cand.deviceId);
      if (ok) {
        devicesToEncrypt.push(cand);
      }
    }));

    // eslint-disable-next-line no-console
    console.log('[OMEMO] Legacy sessions ready for:',
      devicesToEncrypt.map(dev => `${dev.jid}:${dev.deviceId}`).join(',') || '(none)');

    if (devicesToEncrypt.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[OMEMO] No OMEMO devices detected for recipient(s). Falling back to plaintext.');
      return { encryptedXml: null, wasEncrypted: false };
    }

    // 2. Encrypt plaintext message body using AES-GCM (random key K + IV)
    const { key, iv, payload } = await nativeMod.aesGcmEncrypt(plaintext);

    // 3. Encrypt the payload key K for each recipient device
    const keysXml: Element[] = [];

    for (const dev of devicesToEncrypt) {
      try {
        const address = `${dev.jid}:${dev.deviceId}`;
        const ciphertext = await nativeMod.encrypt(address, key);
        const prekey = ciphertext.type === 3; // CiphertextMessage.PREKEY_TYPE is 3

        keysXml.push(
          xml('key', {
            rid: String(dev.deviceId),
            ...(prekey ? { prekey: 'true' } : {}),
          }, ciphertext.body)
        );
        // eslint-disable-next-line no-console
        console.log(`[OMEMO] Added recipient key rid=${dev.deviceId} jid=${dev.jid}`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[OMEMO] Failed to encrypt session key for device ${dev.jid}:${dev.deviceId}`, e);
      }
    }

    if (keysXml.length === 0) {
      // eslint-disable-next-line no-console
      console.warn('[OMEMO] Failed to encrypt for any of the devices. Falling back to plaintext.');
      return { encryptedXml: null, wasEncrypted: false };
    }

    // Save state since we made encryption updates (ratchets advanced)
    await this.saveState();

    // 4. Build Legacy XML Wrapper
    const encryptedXml = xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' },
      xml('header', { sid: String(this.deviceId) },
        ...keysXml,
        xml('iv', {}, iv)
      ),
      xml('payload', {}, payload)
    );

    return { encryptedXml, wasEncrypted: true };
  }

  async decryptMessage(fromJid: string, encryptedXml: Element): Promise<string> {
    if (this.initPromise) {
      await this.initPromise;
    }
    return this.serializedCrypto(() => this.decryptMessageLocked(fromJid, encryptedXml));
  }

  private async decryptMessageLocked(fromJid: string, encryptedXml: Element): Promise<string> {
    const nativeMod = getXmppOmemoModule();
    if (!this.omemoEnabled || !nativeMod) {
      throw new Error('OMEMO is disabled or native module is not available');
    }

    const bareFrom = this.bareJid(fromJid);
    const header = encryptedXml.getChild('header');
    if (!header) {
      throw new Error('Encrypted stanza lacks OMEMO header');
    }

    const sidAttr = header.attrs.sid;
    const senderDeviceId = sidAttr ? parseInt(sidAttr, 10) : 0;
    if (!senderDeviceId) {
      throw new Error('Encrypted header lacks sender sid');
    }

    // Locate key matching our device ID
    const keys = header.getChildren('key');
    const myKeyNode = keys.find((k: Element) => parseInt(k.attrs.rid, 10) === this.deviceId);
    if (!myKeyNode) {
      throw new Error(`Message was not encrypted for our device ID (${this.deviceId})`);
    }

    const prekey = myKeyNode.attrs.prekey === 'true' || myKeyNode.attrs.kex === 'true';
    const encryptedKeyBody = myKeyNode.text().trim();
    const iv = header.getChildText('iv')?.trim() || '';
    const payload = encryptedXml.getChildText('payload')?.trim() || '';

    if (!encryptedKeyBody || !iv || !payload) {
      throw new Error('Missing OMEMO key, IV, or payload');
    }

    // Decrypt the symmetric key K
    const sessionAddress = `${bareFrom}:${senderDeviceId}`;

    // Make sure we have the session state initialized or updated
    await this.getOrCreateSession(bareFrom, senderDeviceId);

    // eslint-disable-next-line no-console
    console.log('[OMEMO] Decrypting payload key from', sessionAddress, prekey ? '(prekey)' : '');
    const decryptedKey = await nativeMod.decrypt(sessionAddress, {
      type: prekey ? 3 : 2, // 3 = PREKEY, 2 = WHISPER
      body: encryptedKeyBody,
    });

    // Save state immediately (advanced ratchets)
    await this.saveState();

    // Decrypt plaintext body using the symmetric key
    const plaintext = await nativeMod.aesGcmDecrypt(decryptedKey, iv, payload);
    return plaintext;
  }
}

export const Omemo = new OmemoService();
