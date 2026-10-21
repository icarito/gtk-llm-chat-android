import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { ThreadMessage } from '@assistant-ui/core';
import { useFocusEffect } from 'expo-router';
import { ThreadPrimitive, type MessageState } from '@assistant-ui/react-native';
import { Colors } from '@/constants/theme';
import type { XmppMessage } from '@/types/xmpp';
import { useConversation } from '@/xmpp/XmppContext';
import { XmppService } from '@/xmpp/XmppService';
import type { QuoteInfo } from '@assistant-ui/react-native';
import { ComposerProvider, ComposerToolbar } from './Composer';
import { PendingFooter, StatusBanner, TypingFooter } from './Footers';
import { MessageBubble } from './MessageBubble';
import { mergeMessages } from './mergeMessages';
import { decideScrollAnchor, isAtBottom, type ScrollMemoryEntry } from './scrollAnchor';
import { useConnectionState, useRoomNick } from './stores';
import { toIMessage, type ChatMessage } from './toIMessage';
import { approvalTransportNotice } from './transportNotice';
import { useHistory } from './useHistory';

function notify(message: string) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert(message);
}

function bare(jid: string): string {
  return jid.split('/')[0] ?? jid;
}

/**
 * Posición de scroll recordada por conversación. Al (re)entrar saltamos al
 * final; si el usuario había subido, volvemos donde estaba. Vive fuera del
 * componente porque debe sobrevivir al desmontaje de la pantalla.
 */
const scrollMemory = new Map<string, ScrollMemoryEntry>();

function ChatPaneImpl({ jid }: { jid: string }) {
  const live = useConversation(jid);
  const online = useConnectionState() === 'online';
  const nick = useRoomNick(jid);
  const group = nick !== null;
  const type = group ? 'groupchat' : 'chat';

  // Volver a enfocar re-dispara el catch-up de MAM (sin vaciar la lista).
  const [syncTick, setSyncTick] = useState(0);
  const listRef = useRef<FlatList<ThreadMessage> | null>(null);
  // Destino del anclaje pendiente: se aplica UNA vez, cuando la lista ya tiene
  // alto de contenido medido (> 0). null = nada pendiente.
  const pendingAnchorRef = useRef<'bottom' | number | null>(null);

  const anchorOnEnter = useCallback(() => {
    const saved = scrollMemory.get(jid);
    pendingAnchorRef.current = saved && !saved.atBottom ? saved.offset : 'bottom';
  }, [jid]);

  // Al (re)entrar a la conversación (foco) o al cambiar de jid en la misma
  // pantalla: al final, o donde estábamos si habíamos subido.
  useFocusEffect(useCallback(() => {
    setSyncTick((t) => t + 1);
    anchorOnEnter();
  }, [anchorOnEnter]));
  useEffect(() => { anchorOnEnter(); }, [anchorOnEnter]);

  // Se aplica el anclaje con la altura ya medida. "al final" queda PEGAJOSO:
  // se reaplica en cada cambio de tamaño mientras el usuario no arrastre, para
  // que la lista aterrice al fondo aunque MAM/descifrado agreguen contenido
  // después. Un offset recordado se aplica una sola vez.
  const onContentSizeChange = useCallback((_width: number, height: number) => {
    const target = pendingAnchorRef.current;
    const list = listRef.current;
    if (target === null || !list || height <= 0) return;
    if (target === 'bottom') { list.scrollToEnd({ animated: false }); return; }
    pendingAnchorRef.current = null;
    const resolved = decideScrollAnchor(scrollMemory.get(jid), height);
    if (resolved.kind === 'bottom') list.scrollToEnd({ animated: false });
    else list.scrollToOffset({ offset: resolved.offset, animated: false });
  }, [jid]);

  // El usuario tomó el control: se cancela el anclaje. `onScrollBeginDrag` sólo
  // se dispara con un arrastre real (no con el desplazamiento programático), a
  // diferencia de inferirlo de la dirección del offset.
  const onScrollBeginDrag = useCallback(() => { pendingAnchorRef.current = null; }, []);

  // Registrar la posición para poder restaurarla al reentrar. Handlers de nivel
  // lista, estables — ver AGENTS.md sobre las props del list.
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollMemory.set(jid, {
      offset: contentOffset.y,
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
      atBottom: isAtBottom(contentOffset.y, contentSize.height, layoutMeasurement.height),
    });
  }, [jid]);

  const { history, rehydrating, syncing, exhausted, loadOlder } = useHistory(jid, online, syncTick);

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
  // mergeMessages devuelve newest-first (orden de la lista invertida anterior);
  // la lista de assistant-ui no es invertida: hay que voltearla a oldest-first.
  const messages = useMemo(() => merged.map((m) => toIMessage(m, self)), [merged, self]);
  const displayMessages = useMemo(() => Array.from(messages).reverse(), [messages]);

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

  // ── envío ── (el composer de assistant-ui vive en Composer.tsx; aquí sólo la cita)
  const quoteRef = useRef<((q: QuoteInfo) => void) | null>(null);
  const quote = useCallback((m: ChatMessage) => {
    quoteRef.current?.({ messageId: String(m._id), text: m.text.slice(0, 200) });
  }, []);

  const resolveReply = useCallback((q: QuoteInfo) => {
    const src = mergedRef.current.find((m) => m.id === q.messageId);
    if (!src) return undefined;
    const author = src.direction === 'out'
      ? bare(XmppService.getAccount()?.jid ?? '')
      : group ? `${jid}/${src.senderNick ?? src.from.split('/')[1] ?? ''}` : bare(src.from);
    return { id: group ? src.stanzaId ?? src.id : src.id, jid: author, quotedText: q.text };
  }, [jid, group]);

  // ── acciones sobre mensajes ──
  const onRetry = useCallback((id: string) => {
    XmppService.retryMessage(jid, id).catch(() => notify('Sin conexión — no se pudo reenviar'));
  }, [jid]);

  const renderRow = useCallback(({ message }: { message: MessageState }) => (
    <MessageBubble
      message={message}
      jid={jid}
      group={group}
      onRetry={onRetry}
      onQuote={quote}
      notify={notify}
    />
  ), [jid, group, onRetry, quote]);

  const hasMessages = displayMessages.length > 0;

  return (
    <ComposerProvider
      jid={jid}
      type={type}
      online={online}
      resolveReply={resolveReply}
      notify={notify}
      quoteRef={quoteRef}
      messages={displayMessages}
      hasEarlier={!exhausted && hasMessages}
      onLoadEarlier={loadOlder}
      isLoading={rehydrating || syncing}
    >
      <View style={styles.root}>
        {!online ? <StatusBanner text="Sin conexión — los mensajes se envían al reconectar" /> : null}
        {rehydrating || syncing ? <StatusBanner busy text={rehydrating ? 'Rehidratando historial' : 'Sincronizando MAM'} /> : null}
        <ThreadPrimitive.MessagesFlatList
          ref={listRef}
          style={styles.list}
          contentContainerStyle={hasMessages ? undefined : styles.emptyContent}
          keyboardShouldPersistTaps="handled"
          autoScroll
          scrollToBottomOnInitialize
          scrollEventThrottle={16}
          onScroll={onScroll}
          onScrollBeginDrag={onScrollBeginDrag}
          onContentSizeChange={onContentSizeChange}
          ListEmptyComponent={renderEmpty}
        >
          {renderRow}
        </ThreadPrimitive.MessagesFlatList>
        <View style={styles.footer}>
          <TypingFooter jid={jid} />
          <PendingFooter jid={jid} />
        </View>
        <ComposerToolbar />
      </View>
    </ComposerProvider>
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
  list: { flex: 1 },
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
  footer: { backgroundColor: Colors.surface },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: Colors.textDim },
});

export const ChatPane = memo(ChatPaneImpl);
