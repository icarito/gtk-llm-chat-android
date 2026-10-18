import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { useFocusEffect } from 'expo-router';
import {
  Chat,
  type MessageMenuItem,
  type PartialChatTheme,
  type ReplyMessage,
  type User,
} from '@kesha-antonov/react-native-chat';
import { Colors } from '@/constants/theme';
import type { XmppMessage } from '@/types/xmpp';
import { useConversation } from '@/xmpp/XmppContext';
import { XmppService } from '@/xmpp/XmppService';
import { RECORDING_MIME } from '@/xmpp/audioUtils';
import { renderMessageAudio } from './AudioBubble';
import { PendingFooter, StatusBanner, TypingFooter } from './Footers';
import { makeRenderCustomView } from './MessageExtras';
import { mergeMessages } from './mergeMessages';
import { renderMessageText } from './richText';
import { useConnectionState, useRoomNick } from './stores';
import { ME, toIMessage, type ChatMessage } from './toIMessage';
import { approvalTransportNotice } from './transportNotice';
import { useHistory } from './useHistory';

// Todo lo que viaja a la lib como prop se reenvía a CADA fila, y la fila se
// salta el render sólo si todas esas props conservan su referencia: por eso
// las constantes viven a nivel de módulo y lo demás en useMemo/useCallback.

const DARK_THEME: PartialChatTheme = {
  colors: {
    accent: Colors.primary,
    background: Colors.background,
    incomingBubble: Colors.assistantBubble,
    outgoingBubble: Colors.userBubble,
    incomingText: Colors.text,
    outgoingText: Colors.userBubbleText,
    incomingMeta: Colors.textDim,
    inputBackground: Colors.inputBackground,
    inputBarBackground: Colors.surface,
    inputText: Colors.text,
    placeholder: Colors.textDim,
    surface: Colors.surface,
    separator: Colors.surfaceBorder,
    error: Colors.error,
  },
};
const MESSAGE_TEXT_PROPS = { markdown: true } as const;
const REPLY_SWIPE = { swipe: { isEnabled: true, direction: 'right' as const } };
const LIST_PROPS = { keyboardShouldPersistTaps: 'handled' as const };
const AUDIO_RECORDING = { isEnabled: true };
// FlashList v2 (New Architecture): recicla filas en vez de montarlas todas.
const USE_FLASH_LIST = true;

const renderUsername = (user: User) => (user.name ? <Text style={styles.username}>{user.name}</Text> : null);

function notify(message: string) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert(message);
}

function bare(jid: string): string {
  return jid.split('/')[0] ?? jid;
}

function ChatPaneImpl({ jid }: { jid: string }) {
  const live = useConversation(jid);
  const online = useConnectionState() === 'online';
  const nick = useRoomNick(jid);
  const group = nick !== null;
  const type = group ? 'groupchat' : 'chat';

  // Volver a enfocar re-dispara el catch-up de MAM (sin vaciar la lista).
  const [syncTick, setSyncTick] = useState(0);
  useFocusEffect(useCallback(() => { setSyncTick((t) => t + 1); }, []));
  const { history, rehydrating, syncing, loadingOlder, exhausted, loadOlder } = useHistory(jid, online, syncTick);

  // Ids con los que figuramos en las reacciones: JID bare, o sala/nick en MUC.
  const self = useMemo(() => {
    const ids = new Set<string>();
    const account = XmppService.getAccount();
    if (account) ids.add(bare(account.jid));
    if (nick) ids.add(`${jid}/${nick}`);
    return ids;
  }, [jid, nick]);

  // Live primero: gana en empate (recibe correcciones, reacciones y retractaciones).
  const merged = useMemo(
    () => mergeMessages(live, history).filter((m) => approvalTransportNotice(m.body) === null),
    [live, history],
  );
  const mergedRef = useRef<XmppMessage[]>(merged);
  mergedRef.current = merged;
  const messages = useMemo(() => merged.map((m) => toIMessage(m, self)), [merged, self]);

  // Avisos de transporte del gateway: toast en vez de burbuja.
  const toasted = useRef(new Set<string>());
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    for (const m of live) {
      if (m.direction !== 'in' || toasted.current.has(m.id)) continue;
      if (approvalTransportNotice(m.body) !== 'toast') continue;
      toasted.current.add(m.id);
      ToastAndroid.show(m.body.trim(), ToastAndroid.SHORT);
    }
  }, [live]);

  // ── envío ──
  const [reply, setReply] = useState<ReplyMessage | null>(null);
  const clearReply = useCallback(() => setReply(null), []);

  const replyRef = useCallback((r: ReplyMessage) => {
    const src = mergedRef.current.find((m) => m.id === String(r._id));
    if (!src) return undefined;
    const author = src.direction === 'out'
      ? bare(XmppService.getAccount()?.jid ?? '')
      : group ? `${jid}/${src.senderNick ?? src.from.split('/')[1] ?? ''}` : bare(src.from);
    return { id: group ? src.stanzaId ?? src.id : src.id, jid: author, quotedText: r.text.slice(0, 200) };
  }, [jid, group]);

  const composingAt = useRef(0);
  const onSend = useCallback(async (sent: ChatMessage[]) => {
    const m = sent[0];
    if (!m) return;
    composingAt.current = 0;
    if (XmppService.getState() !== 'online') {
      notify('Sin conexión — no se pudo enviar');
      return;
    }
    try {
      if (m.audio) {
        // Nota de voz: archivo local -> XEP-0363 -> link OOB.
        const blob = await (await fetch(m.audio)).blob();
        await XmppService.sendFile(jid, blob, `voice_${Date.now()}.m4a`, RECORDING_MIME, type);
      } else {
        const replyTo = m.replyMessage ? replyRef(m.replyMessage) : undefined;
        await XmppService.sendMessage(jid, m.text.trim(), type, replyTo ? { replyTo } : {});
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  }, [jid, type, replyRef]);

  /** Elige un archivo y lo sube por XEP-0363 (el link se manda como OOB). */
  const attaching = useRef(false);
  const onAttach = useCallback(async () => {
    if (attaching.current) return;
    attaching.current = true;
    try {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      const asset = picked.canceled ? undefined : picked.assets?.[0];
      if (!asset) return;
      const blob = await (await fetch(asset.uri)).blob();
      await XmppService.sendFile(jid, blob, asset.name || 'file', asset.mimeType || 'application/octet-stream', type);
    } catch (e) {
      Alert.alert('No se pudo enviar el archivo', e instanceof Error ? e.message : String(e));
    } finally {
      attaching.current = false;
    }
  }, [jid, type]);

  // XEP-0085 saliente: composing al teclear (máx. cada 8s), paused al vaciar.
  const onChangeText = useCallback((text: string) => {
    const now = Date.now();
    if (text.trim()) {
      if (now - composingAt.current > 8000) {
        composingAt.current = now;
        XmppService.sendChatState(jid, 'composing');
      }
    } else if (composingAt.current > 0) {
      composingAt.current = 0;
      XmppService.sendChatState(jid, 'paused');
    }
  }, [jid]);

  // ── acciones sobre mensajes ──
  const onRetry = useCallback((id: string) => {
    XmppService.retryMessage(jid, id).catch(() => notify('Sin conexión — no se pudo reenviar'));
  }, [jid]);

  const messageActions = useCallback((m: ChatMessage): MessageMenuItem[] => {
    const items: MessageMenuItem[] = [];
    if (!m.meta.retracted) {
      items.push({ label: 'Responder', onPress: () => setReply({ _id: m._id, text: m.text, user: m.user, image: m.image, audio: m.audio }) });
      items.push({ label: 'Copiar', onPress: () => { Clipboard.setStringAsync(m.text); } });
    }
    if (m.meta.mine && !m.meta.retracted) {
      items.push({
        label: 'Eliminar',
        destructive: true,
        onPress: () => Alert.alert('Eliminar mensaje', 'Se retractará para todos.', [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Eliminar', style: 'destructive', onPress: () => {
            XmppService.retractMessage(jid, String(m._id)).catch((e) => notify(String(e)));
          } },
        ]),
      });
    }
    return items;
  }, [jid]);

  const reactions = useMemo(() => ({
    isEnabled: true,
    onReactionPress: (m: ChatMessage, emoji: string) => {
      // XEP-0444 fija el conjunto COMPLETO de nuestras reacciones: alternar `emoji` en él.
      const mine = (m.reactions ?? []).filter((r) => r.userIds.includes(ME._id)).map((r) => r.emoji);
      const next = mine.includes(emoji) ? mine.filter((e) => e !== emoji) : [...mine, emoji];
      XmppService.react(jid, String(m._id), next).catch((e) => notify(String(e)));
    },
  }), [jid]);

  // ── props estables hacia la lib ──
  const replyProps = useMemo(() => ({
    ...REPLY_SWIPE,
    message: reply,
    onClear: clearReply,
  }), [reply, clearReply]);
  const renderCustomView = useMemo(() => makeRenderCustomView(jid, onRetry), [jid, onRetry]);
  const renderFooter = useCallback(() => <TypingFooter jid={jid} />, [jid]);
  const renderChatFooter = useCallback(() => <PendingFooter jid={jid} />, [jid]);
  const textInputProps = useMemo(() => ({
    editable: online,
    placeholder: online ? 'Escribe un mensaje…' : 'Sin conexión',
    onChangeText,
  }), [online, onChangeText]);
  const hasMessages = messages.length > 0;
  const loadEarlierMessagesProps = useMemo(() => ({
    isAvailable: !exhausted && hasMessages,
    onPress: loadOlder,
    isLoading: loadingOlder,
    isInfiniteScrollEnabled: true,
    label: 'Cargar mensajes anteriores',
  }), [exhausted, hasMessages, loadOlder, loadingOlder]);

  return (
    <View style={styles.root}>
      {!online ? <StatusBanner text="Sin conexión — los mensajes se envían al reconectar" /> : null}
      {rehydrating || syncing ? <StatusBanner busy text={rehydrating ? 'Rehidratando historial' : 'Sincronizando MAM'} /> : null}
      <Chat<ChatMessage>
        messages={messages}
        user={ME}
        onSend={onSend}
        locale="es"
        colorScheme="dark"
        darkTheme={DARK_THEME}
        isUsernameVisible={group}
        renderUsername={renderUsername}
        renderAvatar={null}
        messageTextProps={MESSAGE_TEXT_PROPS}
        renderMessageText={renderMessageText}
        renderMessageAudio={renderMessageAudio}
        renderCustomView={renderCustomView}
        isCustomViewBottom
        reply={replyProps}
        reactions={reactions}
        messageActions={messageActions}
        audioRecording={AUDIO_RECORDING}
        onPressActionButton={onAttach}
        textInputProps={textInputProps}
        renderFooter={renderFooter}
        renderChatFooter={renderChatFooter}
        loadEarlierMessagesProps={loadEarlierMessagesProps}
        isFlashListEnabled={USE_FLASH_LIST}
        listProps={LIST_PROPS}
        enableGestureHandlerRootView={false}
        isScrollToBottomEnabled
        renderChatEmpty={renderEmpty}
      />
    </View>
  );
}

function renderEmpty() {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>No hay mensajes aún. Envía uno para empezar.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  username: { color: Colors.primary, fontSize: 12, fontWeight: '600' },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: Colors.textDim },
});

export const ChatPane = memo(ChatPaneImpl);
