import React from 'react';
import { act, render } from '@testing-library/react-native';
import type { XmppMessage } from '@/types/xmpp';

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
jest.mock('@/xmpp/XmppService', () => ({
  XmppService: {
    getAccount: () => ({ jid: 'me@x.org' }),
    getState: () => 'online',
    loadCachedHistory: jest.fn(async () => []),
    restoreCachedActions: jest.fn(async () => {}),
    syncHistory: jest.fn(async () => {}),
    loadOlderHistory: jest.fn(async () => []),
  },
}));
jest.mock('@/chat/stores', () => ({
  useConnectionState: () => 'online',
  useRoomNick: () => undefined,
  usePeerTyping: () => false,
  usePendingActions: () => [],
}));

import { ChatPane } from '@/chat/ChatPane';
import { messages } from '@/xmpp/store';

const liveMsg: XmppMessage = {
  id: 'live-1', from: 'bob@x.org', to: 'me@x.org', type: 'chat', body: 'llega en vivo',
  timestamp: '2026-01-01T10:00:00.000Z', direction: 'in', isGroup: false,
};

it('usa el store REAL: un mensaje que entra tras montar se ve sin remontar', () => {
  messages.reset();
  const screen = render(<ChatPane jid="bob@x.org" />);
  expect(screen.queryByText('llega en vivo')).toBeNull();

  act(() => { messages.setConversation('bob@x.org', [liveMsg]); });
  expect(screen.getByText('llega en vivo')).toBeTruthy();
});
