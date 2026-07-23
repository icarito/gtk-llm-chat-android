import { NativeModules } from 'react-native';
import { xml } from '@xmpp/client';

// 1. Mock Android Keystore-backed persistence
jest.mock('expo-secure-store', () => ({
  ALWAYS: 'always',
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// 2. Mock Native XmppOmemoModule
const mockNativeModule = {
  generateIdentityKeyPair: jest.fn().mockResolvedValue({
    publicKey: 'identity_pub_b64',
    privateKey: 'identity_priv_b64',
  }),
  generatePreKeys: jest.fn().mockResolvedValue([
    { id: 1, publicKey: 'prekey_pub_b64' },
  ]),
  generateSignedPreKey: jest.fn().mockResolvedValue({
    id: 1,
    publicKey: 'signedkey_pub_b64',
    signature: 'sig_b64',
    timestamp: 12345,
  }),
  createSession: jest.fn().mockResolvedValue(null),
  encrypt: jest.fn().mockResolvedValue({
    type: 3,
    body: 'encrypted_key_b64',
  }),
  decrypt: jest.fn().mockResolvedValue('key_b64'),
  serialize: jest.fn().mockResolvedValue('{"localRegistrationId":12345,"sessions":{}}'),
  deserialize: jest.fn().mockResolvedValue(true),
  aesGcmEncrypt: jest.fn().mockImplementation((plaintext) => {
    const randomHex = () => Math.random().toString(36).slice(2, 10);
    return Promise.resolve({
      key: `mock_key_${randomHex()}`,
      iv: `mock_iv_${randomHex()}`,
      payload: `payload_for_${plaintext}`,
    });
  }),
  aesGcmDecrypt: jest.fn().mockResolvedValue('Hello OMEMO!'),
};

NativeModules.XmppOmemoModule = mockNativeModule;

import { Omemo } from '../src/xmpp/xep-0384';

describe('OMEMO XEP-0384 Encryption & Decryption', () => {
  const mockXmppClient = {
    iqCaller: {
      request: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('initializes and saves state when no existing file is found', async () => {
    await Omemo.init('test@fuentelibre.org', mockXmppClient, true);

    expect(Omemo.isEnabled()).toBe(true);
    expect(Omemo.getDeviceId()).toBeGreaterThan(0);
    expect(Omemo.getRegistrationId()).toBeGreaterThan(0);
    expect(mockNativeModule.generateIdentityKeyPair).toHaveBeenCalled();
    expect(mockNativeModule.generatePreKeys).toHaveBeenCalledWith(100);
    expect(mockNativeModule.generateSignedPreKey).toHaveBeenCalled();
  });

  it('fetches and caches device lists', async () => {
    const responseIq = xml('iq', { type: 'result' },
      xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
        xml('items', { node: 'eu.siacs.conversations.axolotl.devicelist' },
          xml('item', {},
            xml('list', { xmlns: 'eu.siacs.conversations.axolotl' },
              xml('device', { id: '123' }),
              xml('device', { id: '456' })
            )
          )
        )
      )
    );

    mockXmppClient.iqCaller.request.mockResolvedValue(responseIq);

    await Omemo.init('test@fuentelibre.org', mockXmppClient, true);
    const devices = await Omemo.fetchDeviceList('contact@fuentelibre.org');

    expect(devices).toEqual([123, 456]);
    expect(mockXmppClient.iqCaller.request).toHaveBeenCalledTimes(1);

    // Fetch again should use cache
    const devicesCached = await Omemo.fetchDeviceList('contact@fuentelibre.org');
    expect(devicesCached).toEqual([123, 456]);
    expect(mockXmppClient.iqCaller.request).toHaveBeenCalledTimes(1); // No new request
  });

  it('publishes its own device list to PEP PubSub', async () => {
    mockXmppClient.iqCaller.request.mockResolvedValue(xml('iq', { type: 'result' }));
    await Omemo.init('test@fuentelibre.org', mockXmppClient, true);
    await Omemo.publishDeviceList();

    expect(mockXmppClient.iqCaller.request).toHaveBeenCalledWith(
      expect.objectContaining({
        attrs: { type: 'set' },
      }),
      15000
    );
  });

  it('publishes key bundle to PEP PubSub', async () => {
    mockXmppClient.iqCaller.request.mockResolvedValue(xml('iq', { type: 'result' }));
    await Omemo.init('test@fuentelibre.org', mockXmppClient, true);
    await Omemo.publishBundle();

    expect(mockXmppClient.iqCaller.request).toHaveBeenCalledWith(
      expect.objectContaining({
        attrs: { type: 'set' },
      }),
      15000
    );
  });

  it('encrypts standard 1:1 messages', async () => {
    const responseIq = xml('iq', { type: 'result' },
      xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
        xml('items', { node: 'eu.siacs.conversations.axolotl.devicelist' },
          xml('item', {},
            xml('list', { xmlns: 'eu.siacs.conversations.axolotl' },
              xml('device', { id: '456' })
            )
          )
        )
      )
    );

    mockXmppClient.iqCaller.request.mockResolvedValue(responseIq);

    await Omemo.init('test@fuentelibre.org', mockXmppClient, true);

    // Mock sessions to exist
    mockNativeModule.serialize.mockResolvedValue(JSON.stringify({
      sessions: {
        'contact@fuentelibre.org:456': 'session_data',
      },
    }));

    const result = await Omemo.encryptMessage('contact@fuentelibre.org', 'Hello OMEMO!');

    expect(result.wasEncrypted).toBe(true);
    expect(result.encryptedXml).toBeDefined();
    expect(result.encryptedXml?.name).toBe('encrypted');
    expect(mockNativeModule.aesGcmEncrypt).toHaveBeenCalledWith('Hello OMEMO!');
    expect(mockNativeModule.encrypt).toHaveBeenCalled();
  });

  it('generates unique random cryptographic key and IV for consecutive encryptions', async () => {
    await Omemo.init('test@fuentelibre.org', mockXmppClient, true);

    const enc1 = await NativeModules.XmppOmemoModule.aesGcmEncrypt('Hello');
    const enc2 = await NativeModules.XmppOmemoModule.aesGcmEncrypt('Hello');

    expect(enc1.key).not.toBe(enc2.key);
    expect(enc1.iv).not.toBe(enc2.iv);
  });

  it('decrypts encrypted messages', async () => {
    await Omemo.init('test@fuentelibre.org', mockXmppClient, true);

    const encryptedXml = xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' },
      xml('header', { sid: '456' },
        xml('key', { rid: String(Omemo.getDeviceId()), prekey: 'true' }, 'encrypted_key'),
        xml('iv', {}, 'iv_b64')
      ),
      xml('payload', {}, 'payload_b64')
    );

    // Mock session retrieval/creation
    mockNativeModule.serialize.mockResolvedValue(JSON.stringify({
      sessions: {
        'contact@fuentelibre.org:456': 'session_data',
      },
    }));

    const plaintext = await Omemo.decryptMessage('contact@fuentelibre.org', encryptedXml);

    expect(plaintext).toBe('Hello OMEMO!');
    expect(mockNativeModule.decrypt).toHaveBeenCalledWith(
      'contact@fuentelibre.org:456',
      { type: 3, body: 'encrypted_key' }
    );
    expect(mockNativeModule.aesGcmDecrypt).toHaveBeenCalledWith('key_b64', 'iv_b64', 'payload_b64');
  });

});
