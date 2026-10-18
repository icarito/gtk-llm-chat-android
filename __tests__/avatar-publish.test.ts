import { avatarId, base64ToBytes, buildPublishData, buildPublishMetadata } from '@/xmpp/avatarPublish';

jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('@/xmpp/pep', () => ({ fetchAvatarData: jest.fn() }));
jest.mock('@/xmpp/session', () => ({ usableClient: jest.fn() }));

describe('avatar publish', () => {
  it('id = sha1 hex de los bytes', () => {
    expect(avatarId(base64ToBytes(btoa('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('stanza data/metadata como xat', () => {
    const d = buildPublishData('i1', 'ab', 'QUJD');
    expect(d.toString()).toContain('<publish node="urn:xmpp:avatar:data"><item id="ab"><data xmlns="urn:xmpp:avatar:data">QUJD</data>');
    expect(d.toString()).toContain('<field var="pubsub#max_items"><value>1</value></field>');
    expect(d.toString()).toContain('<field var="pubsub#access_model"><value>presence</value></field>');
    const m = buildPublishMetadata('i2', 'ab', 3, 'image/png', 256, 256);
    expect(m.toString()).toContain('<info bytes="3" id="ab" type="image/png" width="256" height="256"/>');
  });
});
