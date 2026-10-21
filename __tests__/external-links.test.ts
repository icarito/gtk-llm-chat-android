import { Linking } from 'react-native';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { openExternalUrl } from '../src/platform/openExternalUrl.web';

jest.mock('@tauri-apps/api/core', () => ({ isTauri: jest.fn() }));
jest.mock('@tauri-apps/plugin-opener', () => ({ openUrl: jest.fn() }));

const url = 'https://example.invalid/brain?view=memory#notes';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

test('desktop brain links use the native opener instead of a webview popup', async () => {
  jest.mocked(isTauri).mockReturnValue(true);
  jest.mocked(openUrl).mockResolvedValue(undefined);
  await openExternalUrl(url);
  expect(openUrl).toHaveBeenCalledWith(url);
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test('ordinary web keeps the React Native Web link handler', async () => {
  jest.mocked(isTauri).mockReturnValue(false);
  await openExternalUrl(url);
  expect(Linking.openURL).toHaveBeenCalledWith(url);
  expect(openUrl).not.toHaveBeenCalled();
});

test('native opening errors remain observable', async () => {
  jest.mocked(isTauri).mockReturnValue(true);
  jest.mocked(openUrl).mockRejectedValue(new Error('Browser unavailable'));
  await expect(openExternalUrl(url)).rejects.toThrow('Browser unavailable');
});
