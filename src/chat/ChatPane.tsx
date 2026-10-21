import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text, ToastAndroid, View, type FlatList } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { ThreadMessage } from '@assistant-ui/core';
import { ThreadPrimitive, type MessageState } from '@assistant-ui/react-native';
import { Colors } from '@/constants/theme';
import type { XmppMessage } from '@/types/xmpp';
import { useConversation } from '@/xmpp/XmppContext';
import { XmppService } from '@/xmpp/XmppService';
import { getOmemo2 } from '@/xmpp/omemo2';
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
  const enteredAtRef = useRef<number | null>(Date.now());
  useFocusEffect(useCallback(() => {
    setSyncTick((t) => t + 1);
    anchoredRef.current = null;
    enteredAtRef.current = Date.now();
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

  // Control de scroll 100% manual (desactivamos el autoScroll de la librería,
  // que competía con nuestros scrollToEnd y causaba "lanzadas" hacia arriba).
  //
  // Reglas:
  // - Al entrar (ventana de ~1.5s) anclamos una vez al final, cuando el
  //   contenido ya está medido.
  // - Mientras el usuario esté REALMENTE en el borde inferior, cualquier cambio
  //   de tamaño (mensaje nuevo, "escribiendo…") re-ancla al final.
  // - En cuanto el usuario se aleja del borde (scroll manual), soltamos el
  //   anclaje por completo: no volvemos a saltar.
  const atBottomRef = useRef(true);
  const nearBottomRef = useRef(true);
  const withinEntryGrace = () => {
    const t = enteredAtRef.current;
    return t !== null && Date.now() - t < 1500;
  };
  const onScroll = useCallback((e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    const atBottom = contentSize.height <= layoutMeasurement.height + 1 || distance <= 24;
    atBottomRef.current = atBottom;
    // "Cerca del final": dentro de una pantalla de alto desde abajo.
    nearBottomRef.current = atBottom || distance <= layoutMeasurement.height;
  }, []);
  const onScrollBeginDrag = useCallback(() => { atBottomRef.current = false; nearBottomRef.current = false; }, []);

  // Scroll al final con reintentos: el footer ("escribiendo…") modifica el
  // tamaño del contenido y en web ese layout puede quedar listo unos frames
  // después; una sola llamada puede aterrizar antes del footer.
  const scrollToEndNow = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    for (const delay of [0, 60, 150]) {
      setTimeout(() => list?.scrollToEnd({ animated: false }), delay);
    }
  }, []);

  const onContentSizeChange = useCallback((_w: number, h: number) => {
    if (h <= 0) return;
    if (atBottomRef.current || nearBottomRef.current || withinEntryGrace()) {
      scrollToEndNow();
    }
  }, [scrollToEndNow]);

  // "escribiendo…" como footer: al aparecer, re-anclamos (si estamos cerca del
  // final o sin haber hecho scroll manual).
  const prevTypingRef = useRef(typing);
  useEffect(() => {
    const appears = typing && !prevTypingRef.current;
    prevTypingRef.current = typing;
    if (!appears) return;
    if (atBottomRef.current || nearBottomRef.current || withinEntryGrace()) {
      scrollToEndNow();
    }
  }, [typing, scrollToEndNow]);

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

  // OMEMO: si quedaron mensajes sin descifrar (motor aún no listo al entrar en
  // frío, o device list pendiente), reintenta en un bucle acotado: espera a que
  // el motor OMEMO 2 esté listo, refresca la device list del contacto y re-dispara
  // el catch-up de MAM para que el descifrado se re-intente y cure los placeholders
  // (p.ej. en la primera entrada a un chat con un agente). Se detiene cuando ya
  // no quedan mensajes bloqueados o al agotar los intentos.
  useEffect(() => {
    if (!online || !jid) return;
    const hasLocked = () => mergedRef.current.some((m) => isUndecryptableBody(m.body));
    if (!hasLocked()) return;
    let stopped = false;
    let tries = 0;
    const attempt = () => {
      if (stopped) return;
      if (!getOmemo2()) {
        if (tries++ < 12) setTimeout(attempt, 700);
        return;
      }
      // "Calienta" la sesión (equivalente a haberle hablado) y luego re-sincroniza
      // MAM para reintentar el descifrado y curar los placeholders.
      XmppService.omemo2.warmupAgainst(bare(jid))
        .catch(() => {})
        .then(() => XmppService.omemo2.refresh(bare(jid)))
        .then(() => { if (!stopped) setSyncTick((t) => t + 1); })
        .catch(() => {});
    };
    attempt();
    return () => { stopped = true; };
  }, [online, jid]);

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
