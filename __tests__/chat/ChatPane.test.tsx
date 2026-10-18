import React from 'react';
import { render } from '@testing-library/react-native';
import type { XmppMessage } from '@/types/xmpp';

const mockMsg: XmppMessage = {
  id: 'm1', from: 'bob@x.org', to: 'me@x.org', type: 'chat', body: 'hola mundo',
  timestamp: '2026-01-01T10:00:00.000Z', direction: 'in', isGroup: false,
};

jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('expo-audio', () => ({ createAudioPlayer: jest.fn(), setAudioModeAsync: jest.fn() }));
jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@/xmpp/XmppContext', () => ({ useConversation: () => [mockMsg] }));
jest.mock('@/xmpp/XmppService', () => ({ XmppService: { getAccount: () => ({ jid: 'me@x.org' }), getState: () => 'online' } }));
jest.mock('@/chat/stores', () => ({
  useConnectionState: () => 'online',
  useRoomNick: () => undefined,
}));
jest.mock('@/chat/useHistory', () => ({
  useHistory: () => ({ history: [], rehydrating: false, syncing: false, loadingOlder: false, exhausted: true, loadOlder: jest.fn() }),
}));

import { ChatPane } from '@/chat/ChatPane';

// Smoke: monta la lib real (ESM + mocks nativos) sin lanzar. Las filas no se
// pueden aseverar: la lib espera onLayout de la lista y jest no lo emite.
it('mounts the chat container', () => {
  const { getByTestId } = render(<ChatPane jid="bob@x.org" />);
  expect(getByTestId('GC_WRAPPER')).toBeTruthy();
});
