import React from 'react';
import { render } from '@testing-library/react-native';
import type { XmppMessage } from '@/types/xmpp';

const mockMsg: XmppMessage = {
  id: 'm1', from: 'bob@x.org', to: 'me@x.org', type: 'chat', body: 'hola mundo',
  timestamp: '2026-01-01T10:00:00.000Z', direction: 'in', isGroup: false,
};

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 48, left: 0, right: 0 }) }));
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
const mockRecorder = { prepareToRecordAsync: jest.fn(), record: jest.fn(), stop: jest.fn(), uri: 'file:///v.m4a' };
jest.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })) },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(),
  createAudioPlayer: jest.fn(),
  useAudioRecorder: () => mockRecorder,
  useAudioRecorderState: () => ({ durationMillis: 0, metering: -60 }),
}));
jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@/chat/attachPicker', () => ({ chooseAttachment: jest.fn() }));
jest.mock('@/xmpp/XmppContext', () => ({ useConversation: () => [mockMsg], useRoom: () => undefined }));
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

// Smoke: monta el chat (assistant-ui Thread + burbujas propias) sin lanzar y
// renderiza la burbuja del mensaje mock.
it('mounts the chat container and renders a message bubble', () => {
  const { getByText } = render(<ChatPane jid="bob@x.org" />);
  expect(getByText('hola mundo')).toBeTruthy();
});
