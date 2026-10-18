jest.mock('expo-application', () => ({ nativeApplicationVersion: '0.1.0' }));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('expo-intent-launcher', () => ({}));

import { checkForUpdate, isNewer, isTrustedUrl, pickApkAsset } from '../src/update/updater';

describe('isNewer', () => {
  it('compara núcleo numérico', () => {
    expect(isNewer('0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('v1.0', '0.9.9')).toBe(true);
  });
  it('prerelease < release y rc2 < rc3', () => {
    expect(isNewer('0.2.0', '0.2.0-rc3')).toBe(true);
    expect(isNewer('0.2.0-rc3', '0.2.0')).toBe(false);
    expect(isNewer('0.2.0-rc3', '0.2.0-rc2')).toBe(true);
    expect(isNewer('0.2.0-rc2', '0.2.0-rc3')).toBe(false);
    expect(isNewer('0.2.0-rc1', '0.1.9')).toBe(true);
  });
});

describe('pickApkAsset', () => {
  it('elige el .apk', () => {
    const a = pickApkAsset({ assets: [{ name: 'x.ipa', browser_download_url: 'u1' }, { name: 'app.APK', browser_download_url: 'u2' }] });
    expect(a?.browser_download_url).toBe('u2');
    expect(pickApkAsset({ assets: [{ name: 'x.ipa', browser_download_url: 'u' }] })).toBeUndefined();
  });
});

describe('isTrustedUrl', () => {
  it('solo https en hosts de GitHub', () => {
    expect(isTrustedUrl('https://github.com/a/b/releases/download/v1/x.apk')).toBe(true);
    expect(isTrustedUrl('https://objects.githubusercontent.com/x')).toBe(true);
    expect(isTrustedUrl('http://github.com/x')).toBe(false);
    expect(isTrustedUrl('https://github.com.evil.com/x')).toBe(false);
    expect(isTrustedUrl('https://evil.com/github.com/')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  const mock = (res: Partial<Response> | Error) => {
    (global as { fetch: unknown }).fetch = jest.fn(() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)));
  };
  const rel = { tag_name: 'v0.3.0', body: 'notas', assets: [{ name: 'a.apk', browser_download_url: 'https://github.com/a.apk', size: 5 }] };

  it('devuelve info si hay versión nueva', async () => {
    mock({ ok: true, status: 200, json: async () => rel });
    expect(await checkForUpdate('0.2.0')).toEqual({ version: '0.3.0', tag: 'v0.3.0', notes: 'notas', url: 'https://github.com/a.apk', size: 5, name: 'a.apk' });
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers['User-Agent']).toBe('exit-x-chat-updater');
  });
  it('null si está al día', async () => {
    mock({ ok: true, status: 200, json: async () => rel });
    expect(await checkForUpdate('0.3.0')).toBeNull();
  });
  it('errores honestos', async () => {
    mock(new Error('net'));
    await expect(checkForUpdate('0.1.0')).rejects.toThrow(/Sin conexión/);
    mock({ ok: false, status: 404 });
    await expect(checkForUpdate('0.1.0')).rejects.toThrow(/no hay versiones/);
    mock({ ok: true, status: 200, json: async () => ({ tag_name: 'v9.0.0', assets: [] }) });
    await expect(checkForUpdate('0.1.0')).rejects.toThrow(/APK/);
  });
});
