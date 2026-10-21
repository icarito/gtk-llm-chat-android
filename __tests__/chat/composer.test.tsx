import React, { memo, useRef } from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { QuoteInfo } from '@assistant-ui/react-native';
import { ComposerProvider, renderComposerToolbar } from '@/chat/Composer';
import { XmppService } from '@/xmpp/XmppService';

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 48, left: 0, right: 0 }) }));
jest.mock('@/xmpp/XmppService', () => ({
  XmppService: {
    getState: jest.fn(() => 'online'),
    sendMessage: jest.fn(async () => undefined),
    sendFile: jest.fn(async () => undefined),
    sendChatState: jest.fn(),
    listAdhocCommands: jest.fn(async () => []),
  },
}));
jest.mock('@/xmpp/XmppContext', () => ({ useRoom: () => undefined }));
jest.mock('@/chat/attachPicker', () => ({ chooseAttachment: jest.fn() }));
const mockRecorder = { prepareToRecordAsync: jest.fn(), record: jest.fn(), stop: jest.fn(), uri: 'file:///v.m4a' };
jest.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })) },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: () => mockRecorder,
  useAudioRecorderState: () => ({ durationMillis: 7000, metering: -20 }),
}));

const rows = jest.fn();
// Hace de fila de <Chat>: se re-renderiza sólo si cambian sus props (como en la lib).
const Row = memo(function Row({ toolbar }: { toolbar: () => React.ReactNode }) {
  rows();
  return <>{toolbar()}</>;
});

function Harness({ quoteRef, resolveReply }: { quoteRef: React.MutableRefObject<((q: QuoteInfo) => void) | null>; resolveReply: jest.Mock }) {
  const notify = useRef(jest.fn()).current;
  return (
    <ComposerProvider jid="a@b" type="chat" online messages={[]} resolveReply={resolveReply} notify={notify} quoteRef={quoteRef}>
      <Row toolbar={renderComposerToolbar} />
      <Text>fin</Text>
    </ComposerProvider>
  );
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test('teclear no re-renderiza el contenedor; enviar manda texto con cita', async () => {
  const quoteRef = { current: null as ((q: QuoteInfo) => void) | null };
  const resolveReply = jest.fn(() => ({ id: 'm1', jid: 'x@y', quotedText: 'hola' }));
  render(<Harness quoteRef={quoteRef} resolveReply={resolveReply} />);
  const before = rows.mock.calls.length;
  const input = screen.getByPlaceholderText('Escribe un mensaje…');
  fireEvent.changeText(input, 'ho');
  fireEvent.changeText(input, 'hola');
  await flush();
  expect(rows.mock.calls.length).toBe(before);
  expect(XmppService.sendChatState).toHaveBeenCalledWith('a@b', 'composing');

  act(() => quoteRef.current?.({ messageId: 'm1', text: 'hola' }));
  fireEvent.press(screen.getByLabelText('Enviar'));
  await flush();
  expect(XmppService.sendMessage).toHaveBeenCalledWith('a@b', 'hola', 'chat', { replyTo: { id: 'm1', jid: 'x@y', quotedText: 'hola' } });
});

test('el adjunto se previsualiza, se puede quitar y sólo sube al enviar', async () => {
  const { chooseAttachment } = jest.requireMock('@/chat/attachPicker');
  (global as { fetch: unknown }).fetch = jest.fn(async () => ({ blob: async () => 'BLOB' }));
  chooseAttachment.mockResolvedValue({ uri: 'file:///x.pdf', name: 'x.pdf', mime: 'application/pdf' });
  (XmppService.sendFile as jest.Mock).mockClear();
  render(<Harness quoteRef={{ current: null }} resolveReply={jest.fn()} />);
  fireEvent.press(screen.getByLabelText('Adjuntar'));
  await flush();
  expect(screen.getByText('x.pdf')).toBeTruthy();
  expect(XmppService.sendFile).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Quitar adjunto'));
  await flush();
  expect(screen.queryByText('x.pdf')).toBeNull();

  fireEvent.press(screen.getByLabelText('Adjuntar'));
  await flush();
  fireEvent.changeText(screen.getByPlaceholderText('Escribe un mensaje…'), 'mira');
  fireEvent.press(screen.getByLabelText('Enviar'));
  await flush();
  expect(XmppService.sendFile).toHaveBeenCalledWith('a@b', 'BLOB', 'x.pdf', 'application/pdf', 'chat');
});

test('nota de voz: feedback inmediato, deslizar cancela y no sube', async () => {
  (XmppService.sendFile as jest.Mock).mockClear();
  render(<Harness quoteRef={{ current: null }} resolveReply={jest.fn()} />);
  const mic = screen.getByLabelText('Mantén presionado para grabar una nota de voz');
  act(() => { mic.props.onResponderGrant({ nativeEvent: { pageX: 300 } }); });
  // Sin esperar permiso/prepare: la barra ya está a la vista.
  expect(screen.getByText('‹ Desliza para cancelar')).toBeTruthy();
  expect(screen.getByText('0:07')).toBeTruthy();
  expect(screen.queryByPlaceholderText('Escribe un mensaje…')).toBeNull();
  act(() => { mic.props.onResponderMove({ nativeEvent: { pageX: 150 } }); });
  expect(screen.getByText('Suelta para cancelar')).toBeTruthy();
  act(() => { mic.props.onResponderRelease(); });
  await flush();
  expect(XmppService.sendFile).not.toHaveBeenCalled();
  expect(screen.getByPlaceholderText('Escribe un mensaje…')).toBeTruthy();
});
