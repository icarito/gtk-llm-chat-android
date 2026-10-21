import React from 'react';
import { act, render } from '@testing-library/react-native';
import type { XmppMessage } from '@/types/xmpp';

const mockMsg: XmppMessage = {
  id: 'm1', from: 'bob@x.org', to: 'me@x.org', type: 'chat', body: 'hola mundo',
  timestamp: '2026-01-01T10:00:00.000Z', direction: 'in', isGroup: false,
};

let mockLive: XmppMessage[] = [];
const mockListeners = new Set<() => void>();
const mockSetLive = (next: XmppMessage[]) => { mockLive = next; [...mockListeners].forEach((fn) => fn()); };

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 48, left: 0, right: 0 }) }));
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })) },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(),
  createAudioPlayer: jest.fn(),
  useAudioRecorder: () => ({ prepareToRecordAsync: jest.fn(), record: jest.fn(), stop: jest.fn(), uri: 'file:///v.m4a' }),
  useAudioRecorderState: () => ({ durationMillis: 0, metering: -60 }),
}));
jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@/chat/attachPicker', () => ({ chooseAttachment: jest.fn() }));
jest.mock('@/xmpp/XmppContext', () => ({
  useConversation: () => require('react').useSyncExternalStore(
    (cb: () => void) => { mockListeners.add(cb); return () => { mockListeners.delete(cb); }; },
    () => mockLive,
  ),
  useRoom: () => undefined,
}));
jest.mock('@/xmpp/XmppService', () => ({ XmppService: { getAccount: () => ({ jid: 'me@x.org' }), getState: () => 'online' } }));
jest.mock('@/chat/stores', () => ({
  useConnectionState: () => 'online',
  useRoomNick: () => undefined,
  usePeerTyping: () => false,
  usePendingActions: () => [],
}));
jest.mock('@/chat/useHistory', () => ({
  useHistory: () => ({ history: [], rehydrating: false, syncing: false, loadingOlder: false, exhausted: true, loadOlder: jest.fn() }),
}));

import { ChatPane } from '@/chat/ChatPane';

beforeEach(() => { mockLive = []; mockListeners.clear(); });

it('muestra un mensaje que llega DESPUÉS del montaje (sin remontar)', () => {
  const screen = render(<ChatPane jid="bob@x.org" />);
  expect(screen.queryByText('hola mundo')).toBeNull();

  act(() => { mockSetLive([mockMsg]); });
  expect(screen.getByText('hola mundo')).toBeTruthy();
});
