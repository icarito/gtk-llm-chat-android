import { omemo2Api } from '@/xmpp/omemo2';

jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-secure-store', () => ({}));

describe('omemo2Api sin motor', () => {
  it('identityChanges es estable y vacío', () => {
    expect(omemo2Api.identityChanges('a@x.org')).toBe(omemo2Api.identityChanges('a@x.org/res'));
    expect(omemo2Api.identityChanges('a@x.org')).toHaveLength(0);
  });
  it('setTrust devuelve false y ownJid es null', async () => {
    expect(await omemo2Api.setTrust('a@x.org', 1, 'verified')).toBe(false);
    expect(omemo2Api.ownJid).toBeNull();
  });
});
