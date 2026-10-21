import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text, ToastAndroid, View, type FlatList } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { ThreadMessage } from '@assistant-ui/core';
import { ThreadPrimitive, type MessageState } from '@assistant-ui/react-native';
import { Colors } from '@/constants/theme';
import type { XmppMessage } from '@/types/xmpp';
import { useConversation } from '@/xmpp/XmppContext';
import { XmppService } from '@/xmpp/XmppService';
import type { QuoteInfo } from '@assistant-ui/react-native';
import { ComposerProvider, ComposerToolbar } from './Composer';
import { PendingFooter, StatusBanner, TypingIndicator } from './Footers';
import { MessageBubble } from './MessageBubble';
import { avatarTargetJid } from './Avatar';
import { mergeMessages } from './mergeMessages';
import { useConnectionState, usePeerTyping, useRoomNick } from './stores';
import { toIMessage, type ChatMessage } from './toIMessage';
import { approvalTransportNotice } from './transportNotice';
import { useHistory } from './useHistory';
import { isUndecryptableBody } from './mergeMessages';

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
  const typing = usePeerTyping(jid);
  const type = group ? 'groupchat' : 'chat';

  // Volver a enfocar re-dispara el catch-up de MAM (sin vaciar la lista). El
  // anclaje se re-resuelve al entrar: cae al final (ver useEffect de anclaje abajo)
  // y la lista queda pegada al final mientras estés abajo.
  const [syncTick, setSyncTick] = useState(0);
  const listRef = useRef<FlatList<ThreadMessage> | null>(null);
  const anchoredRef = useRef<string | null>(null);
  useFocusEffect(useCallback(() => {
    setSyncTick((t) => t + 1);
    anchoredRef.current = null;
    // Desktop/web: auto-enfoque del input al entrar a la sala (en mobile no,
    // para no abrir el teclado virtual).
    if (Platform.OS === 'web') {
      const t = setTimeout(() => {
        const doc = (globalThis as unknown as { document?: { querySelector(q: string): HTMLElement | null } }).document;
        doc?.querySelector('[data-testid="composer-input"]')?.focus?.();
      }, 80);
      return () => clearTimeout(t);
    }
  }, []));

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

  // Anclaje determinista: el init auto-scroll de la lista puede aterrizar arriba
  // cuando el historial llega tarde (contentHeight 0 al inicializar). Lo forzamos
  // nosotros: una vez cargado y con layout medido, scrollToEnd.
  useEffect(() => {
    if (rehydrating || syncing) return;
    if (displayMessages.length === 0) return;
    if (anchoredRef.current === jid) return;
    const t = setTimeout(() => {
      anchoredRef.current = jid;
      listRef.current?.scrollToEnd({ animated: false });
    }, 60);
    return () => clearTimeout(t);
  }, [jid, displayMessages.length, rehydrating, syncing]);

  // Pegajoso: mientras el usuario esté al final, el contenido nuevo (mensajes,
  // "escribiendo…") debe mostrarse al vuelo. Se desactiva al arrastrar.
  const atBottomRef = useRef(true);
  const wasPinnedRef = useRef(true);
  const onScroll = useCallback((e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    // Consideramos "al final" el borde mismo de la lista (sin margen arbitrario):
    // así el autoscroll llega hasta el último elemento y no se queda a 8px.
    const atBottom = contentSize.height <= layoutMeasurement.height + 1
      || contentSize.height - contentOffset.y - layoutMeasurement.height <= 1;
    atBottomRef.current = atBottom;
    if (atBottom) wasPinnedRef.current = true;
  }, []);
  // `onScrollBeginDrag` sólo se dispara con un arrastre real del usuario (no con
  // scroll programático); es el único que suelta el anclaje.
  const onScrollBeginDrag = useCallback(() => { atBottomRef.current = false; wasPinnedRef.current = false; }, []);
  const onContentSizeChange = useCallback((_w: number, h: number) => {
    // Si estamos (o estábamos) pegados al final, ante cualquier cambio de tamaño
    // (mensaje nuevo, descifrado tardío, "escribiendo…") re-anclamos al final
    // REAL: scrollToEnd con el padding del contenido incluido.
    if (h <= 0) return;
    if (atBottomRef.current || wasPinnedRef.current) {
      listRef.current?.scrollToEnd({ animated: false });
    }
  }, []);

  // Avatares XEP-0084: pedir el de cada remitente entrante que aún no tenemos
  // (los eventos PEP sólo llegan cuando publican algo nuevo).
  useEffect(() => {
    if (typeof XmppService.getAvatarUri !== 'function' || typeof XmppService.fetchAvatar !== 'function') return;
    const seen = new Set<string>();
    for (const m of merged) {
      if (m.direction === 'out') continue;
      let senderBare = m.type === 'groupchat' ? m.senderRealJid : undefined;
      if (!senderBare) {
        const full = m.type === 'groupchat'
          ? `${m.from.split('/')[0]}/${m.senderNick ?? m.from.split('/')[1] ?? ''}`
          : m.from.split('/')[0] ?? m.from;
        senderBare = avatarTargetJid(full);
      }
      if (!senderBare || seen.has(senderBare)) continue;
      seen.add(senderBare);
      if (!XmppService.getAvatarUri(senderBare)) void XmppService.fetchAvatar(senderBare);
    }
  }, [merged]);

  // OMEMO: si quedaron mensajes sin descifrar (motor aún no listo o device list
  // pendiente), reintenta una vez: refresca device list del contacto y re-dispara
  // el catch-up de MAM para que el descifrado se re-intente y cure los placeholders.
  const retriedDecryptRef = useRef(false);
  useEffect(() => {
    if (!online || retriedDecryptRef.current) return;
    const hasLocked = merged.some((m) => isUndecryptableBody(m.body));
    if (!hasLocked) return;
    retriedDecryptRef.current = true;
    XmppService.omemo2.refresh(bare(jid)).then(() => {
      setSyncTick((t) => t + 1);
    }).catch(() => {});
  }, [online, merged, jid]);

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
      <KeyboardAvoidingView style={styles.kav} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.root}>
          {!online ? <StatusBanner text="Sin conexión — los mensajes se envían al reconectar" /> : null}
          {rehydrating || syncing ? <StatusBanner busy text={rehydrating ? 'Rehidratando historial' : 'Sincronizando MAM'} /> : null}
          <ThreadPrimitive.MessagesFlatList
            ref={listRef}
            style={styles.list}
            contentContainerStyle={hasMessages ? styles.listContent : styles.emptyContent}
            keyboardShouldPersistTaps="handled"
            autoScroll
            scrollToBottomOnInitialize
            scrollEventThrottle={16}
            onScroll={onScroll}
            onScrollBeginDrag={onScrollBeginDrag}
            onContentSizeChange={onContentSizeChange}
            ListFooterComponent={typing ? <TypingIndicator /> : null}
            ListEmptyComponent={renderEmpty}
          >
            {renderRow}
          </ThreadPrimitive.MessagesFlatList>
          <View style={styles.footer}>
            <PendingFooter jid={jid} />
          </View>
          <ComposerToolbar />
        </View>
      </KeyboardAvoidingView>
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
  kav: { flex: 1 },
  root: { flex: 1, backgroundColor: Colors.background },
  list: { flex: 1 },
  listContent: { paddingBottom: 16 },
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
  footer: { backgroundColor: Colors.surface },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: Colors.textDim },
});

export const ChatPane = memo(ChatPaneImpl);
