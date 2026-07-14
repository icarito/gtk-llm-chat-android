import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useXmpp } from '@/xmpp/XmppContext';
import { XmppService } from '@/xmpp/XmppService';
import { formatAgentActivity, formatAgentDetails, parseAgentStatus } from '@/xmpp/agentStatus';
import { Colors } from '@/constants/theme';
import type { XmppMessage, XmppPendingAction } from '@/types/xmpp';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LAST_CHAT_KEY = '@gtk_llm_chat:last_chat_jid';

/** Same message, seen twice: once live, once replayed from the archive. */
const DEDUPE_WINDOW_MS = 30_000;

/** How much of the conversation to show on open. The rest stays one tap away. */
const INITIAL_PAGE_SIZE = 30;
const OLDER_PAGE_SIZE = 30;

/**
 * Merge message lists into one chronological, deduped conversation.
 *
 * Ids can't carry the dedupe on their own: a message we sent live is stored
 * with our local id, and the archive hands the same message back under its own
 * archive id. So two messages match when they are the same text, in the same
 * direction, within a short window — mirroring attach_mam_to_recent_message in
 * the GTK client.
 */
function mergeMessages(...lists: XmppMessage[][]): XmppMessage[] {
  const merged: XmppMessage[] = [];
  const seenIds = new Set<string>();

  for (const msg of lists.flat()) {
    if (seenIds.has(msg.id)) continue;
    const time = new Date(msg.timestamp).getTime();
    const duplicate = merged.some(
      (m) => m.body === msg.body
        && m.direction === msg.direction
        && Math.abs(new Date(m.timestamp).getTime() - time) <= DEDUPE_WINDOW_MS,
    );
    if (duplicate) continue;
    seenIds.add(msg.id);
    merged.push(msg);
  }

  return merged.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

export default function XmppChatScreen() {
  const { jid } = useLocalSearchParams<{ jid: string }>();
  const decodedJid = decodeURIComponent(jid || '');
  const {
    state,
    messages,
    pendingActions,
    contacts,
    sendMessage,
    answerPendingAction,
    setApprovalBypass,
    connect,
    isConfigured,
  } = useXmpp();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<XmppMessage[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [agentControlsOpen, setAgentControlsOpen] = useState(false);
  const [bypassEnabled, setBypassEnabled] = useState(false);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const flatListRef = useRef<FlatList<XmppMessage>>(null);

  // Paint the cache immediately on open, then catch up with the archive.
  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    setExhausted(false);

    (async () => {
      const cached = await XmppService.loadCachedHistory(decodedJid, INITIAL_PAGE_SIZE);
      if (cancelled) return;
      setHistory(cached);
    })();

    return () => { cancelled = true; };
  }, [decodedJid]);

  // Catch up whenever we (re)connect — the archive is the source of truth.
  useEffect(() => {
    if (state !== 'online') return;
    let cancelled = false;
    setSyncing(true);

    (async () => {
      try {
        // syncHistory drains the whole archive into the local cache, which can
        // be weeks of messages. Only the tail belongs on screen — the rest sits
        // in the cache behind "load older".
        await XmppService.syncHistory(decodedJid);
        if (cancelled) return;
        const recent = await XmppService.loadCachedHistory(decodedJid, INITIAL_PAGE_SIZE);
        if (cancelled) return;
        setHistory((prev) => (prev.length > recent.length
          ? mergeMessages(prev, recent)  // user already paged further back
          : recent));
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();

    return () => { cancelled = true; };
  }, [decodedJid, state]);

  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder || exhausted || history.length === 0) return;
    setLoadingOlder(true);
    try {
      const older = await XmppService.loadOlderHistory(
        decodedJid, history[0]!.timestamp, OLDER_PAGE_SIZE);
      if (older.length === 0) {
        setExhausted(true);
        return;
      }
      setHistory((prev) => mergeMessages(prev, older));
    } finally {
      setLoadingOlder(false);
    }
  }, [decodedJid, history, loadingOlder, exhausted]);

  // Live messages arrive through the service's map; history comes from cache +
  // MAM. Both are deduped against each other on body+timestamp.
  const liveMsgs = messages.get(decodedJid) || [];
  const sortedMsgs = mergeMessages(history, liveMsgs);
  const msgCount = sortedMsgs.length;
  const chatPendingActions = useMemo(
    () => pendingActions
      .filter((action) => action.conversationJid === decodedJid)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [decodedJid, pendingActions],
  );
  const visiblePending = chatPendingActions[0] ?? null;
  const contact = useMemo(
    () => contacts.find((item) => item.jid === decodedJid),
    [contacts, decodedJid],
  );
  const agentStatus = useMemo(() => parseAgentStatus(contact?.status), [contact?.status]);
  const agentDetails = useMemo(() => formatAgentDetails(agentStatus), [agentStatus]);

  // The list renders inverted (newest at the bottom, growing upward), so the
  // latest message is where the viewport already sits — no scrollToEnd, no
  // timing games, and prepending older history can't yank the view.
  const inverted = useMemo(() => [...sortedMsgs].reverse(), [sortedMsgs]);

  // Persist last visited chat
  useEffect(() => {
    AsyncStorage.setItem(LAST_CHAT_KEY, decodedJid).catch(() => {});
  }, [decodedJid]);

  // Auto-connect without params
  useEffect(() => {
    if (isConfigured && state === 'disconnected') {
      connect('', '', '', '').catch(() => {});
    }
  }, [isConfigured, state, connect]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput('');
    // sendMessage publishes the outgoing message to the service's map and
    // caches it — no local copy needed here.
    try {
      await sendMessage(decodedJid, trimmed, 'chat');
    } catch (e) {
      // ignore
    }
  }, [input, decodedJid, sendMessage]);

  const handleAnswerAction = useCallback(async (action: XmppPendingAction) => {
    setActionBusy(action.id);
    try {
      await answerPendingAction(action.id);
    } finally {
      setActionBusy(null);
    }
  }, [answerPendingAction]);

  const handleToggleBypass = useCallback(async () => {
    const next = !bypassEnabled;
    setBypassEnabled(next);
    setControlNotice(null);
    try {
      await setApprovalBypass(decodedJid, next, 15);
      setControlNotice(next ? 'Bypass activo 15 min' : 'Bypass desactivado');
    } catch (err) {
      setBypassEnabled(!next);
      setControlNotice(String(err));
    }
  }, [bypassEnabled, decodedJid, setApprovalBypass]);

  const renderMessage = useCallback(
    ({ item }: { item: XmppMessage }) => {
      const isMine = item.direction === 'out';

      return (
        <View style={[styles.messageRow,
          isMine ? styles.messageRowRight : styles.messageRowLeft]}>
          <View style={[styles.bubble, isMine ? styles.bubbleRight : styles.bubbleLeft]}>
            {!isMine && item.type === 'groupchat' && (
              <Text style={styles.senderName}>{item.from.split('/')[1] || item.from}</Text>
            )}
            <Text style={[styles.messageText, isMine && styles.messageTextMine]}>{item.body}</Text>
            <Text style={[styles.timestamp, isMine && styles.timestampMine]}>
              {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        </View>
      );
    },
    [],
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: decodedJid,
          headerStyle: { backgroundColor: Colors.surface },
          headerTintColor: Colors.text,
        }}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        <View style={styles.agentToolbar}>
          <View style={styles.statusStrip}>
            <View style={styles.statusMain}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: contact?.presence === 'online' ? Colors.success : Colors.muted },
                ]}
              />
              <Text style={styles.statusActivity} numberOfLines={1}>
                {formatAgentActivity(agentStatus.activity)}
              </Text>
            </View>
            {agentDetails.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.statusMetrics}
              >
                {agentDetails.map((detail) => (
                  <Text key={detail} style={styles.statusMetric} numberOfLines={1}>
                    {detail}
                  </Text>
                ))}
              </ScrollView>
            )}
          </View>

          {visiblePending && (
            <View style={styles.pendingCard}>
              <View style={styles.pendingHeader}>
                <Text style={styles.pendingTitle}>
                  {chatPendingActions.length > 1
                    ? `${chatPendingActions.length} preguntas pendientes`
                    : 'Pregunta pendiente'}
                </Text>
                <Text style={styles.pendingTime}>
                  {new Date(visiblePending.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
              <Text style={styles.pendingDetail} numberOfLines={2}>
                {visiblePending.detail}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pendingActions}>
                {chatPendingActions.map((action) => (
                  <TouchableOpacity
                    key={action.id}
                    style={[styles.actionPill, actionBusy === action.id && styles.actionPillDisabled]}
                    disabled={state !== 'online' || actionBusy !== null}
                    onPress={() => handleAnswerAction(action)}
                  >
                    {actionBusy === action.id ? (
                      <ActivityIndicator size="small" color={Colors.background} />
                    ) : (
                      <Text style={styles.actionPillText}>{action.label}</Text>
                    )}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          <TouchableOpacity
            style={styles.agentControlsToggle}
            onPress={() => setAgentControlsOpen((open) => !open)}
          >
            <Ionicons name="options-outline" size={16} color={Colors.textDim} />
            <Text style={styles.agentControlsToggleText}>Controles del agente</Text>
            <Ionicons
              name={agentControlsOpen ? 'chevron-down' : 'chevron-forward'}
              size={16}
              color={Colors.textDim}
            />
          </TouchableOpacity>

          {agentControlsOpen && (
            <View style={styles.agentControlsPanel}>
              <TouchableOpacity
                style={[styles.bypassButton, bypassEnabled && styles.bypassButtonActive]}
                disabled={state !== 'online'}
                onPress={handleToggleBypass}
              >
                <Ionicons
                  name={bypassEnabled ? 'shield-checkmark' : 'shield-outline'}
                  size={17}
                  color={bypassEnabled ? Colors.background : Colors.text}
                />
                <Text style={[styles.bypassButtonText, bypassEnabled && styles.bypassButtonTextActive]}>
                  Bypass approvals
                </Text>
              </TouchableOpacity>
              {controlNotice && (
                <Text
                  style={[
                    styles.controlNotice,
                    controlNotice.startsWith('Error') || controlNotice.includes('not connected')
                      ? styles.controlNoticeError
                      : undefined,
                  ]}
                  numberOfLines={2}
                >
                  {controlNotice}
                </Text>
              )}
            </View>
          )}
        </View>

        <FlatList
          ref={flatListRef}
          inverted
          data={inverted}
          keyExtractor={(item, index) => `${item.id}-${index}`}
          renderItem={renderMessage}
          contentContainerStyle={styles.listContent}
          extraData={msgCount}
          // Inverted: the "end" of the list is the TOP of the screen, i.e. the
          // oldest message — so reaching it is what pulls in more history.
          onEndReached={handleLoadOlder}
          onEndReachedThreshold={0.3}
          ListFooterComponent={
            msgCount === 0 ? null : (
              <View style={styles.historyHeader}>
                {loadingOlder || syncing ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : exhausted ? (
                  <Text style={styles.historyHeaderText}>Inicio de la conversación</Text>
                ) : (
                  <TouchableOpacity onPress={handleLoadOlder}>
                    <Text style={styles.loadMamText}>Cargar mensajes anteriores</Text>
                  </TouchableOpacity>
                )}
              </View>
            )
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="chatbubbles" size={48} color={Colors.textDim} />
              <Text style={styles.emptyText}>No hay mensajes aún.</Text>
              <Text style={styles.emptySubtext}>Envía un mensaje para empezar.</Text>
            </View>
          }
        />

        {state !== 'online' && (
          <View style={styles.disconnectedBar}>
            <Text style={styles.disconnectedText}>Desconectado — reconectando...</Text>
          </View>
        )}

        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Escribe un mensaje..."
            placeholderTextColor={Colors.textDim}
            multiline
            maxLength={2000}
            onSubmitEditing={handleSend}
            returnKeyType="send"
            editable={state === 'online'}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!input.trim() || state !== 'online') && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!input.trim() || state !== 'online'}
          >
            <Ionicons name="send" size={20} color={Colors.background} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  listContent: { padding: 12, flexGrow: 1 },
  historyHeader: { alignItems: 'center', paddingVertical: 12, minHeight: 40, justifyContent: 'center' },
  historyHeaderText: { color: Colors.textDim, fontSize: 12 },
  loadMamText: { color: Colors.primary, fontSize: 14, fontWeight: '600' },
  messageRow: { flexDirection: 'row', marginBottom: 10 },
  messageRowLeft: { justifyContent: 'flex-start' },
  messageRowRight: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '82%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  bubbleLeft: {
    backgroundColor: Colors.assistantBubble,
    borderWidth: 1,
    borderColor: Colors.assistantBubbleBorder,
    borderBottomLeftRadius: 4,
  },
  bubbleRight: { backgroundColor: Colors.userBubble, borderBottomRightRadius: 4 },
  senderName: { fontSize: 12, fontWeight: '600', color: Colors.primary, marginBottom: 4 },
  messageText: { fontSize: 15, color: Colors.text, lineHeight: 21 },
  messageTextMine: { color: Colors.userBubbleText },
  timestamp: { fontSize: 11, color: Colors.textDim, marginTop: 4, alignSelf: 'flex-end' },
  timestampMine: { color: 'rgba(255,255,255,0.7)' },
  agentToolbar: {
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
  },
  statusStrip: {
    gap: 6,
    paddingHorizontal: 2,
  },
  statusMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusActivity: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700',
    flexShrink: 1,
  },
  statusMetrics: {
    gap: 6,
    paddingRight: 8,
  },
  statusMetric: {
    color: Colors.textDim,
    fontSize: 11,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.inputBackground,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  pendingCard: {
    backgroundColor: Colors.inputBackground,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: 8,
    padding: 10,
    gap: 8,
  },
  pendingHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  pendingTitle: { color: Colors.warning, fontSize: 13, fontWeight: '700' },
  pendingTime: { color: Colors.textDim, fontSize: 12 },
  pendingDetail: { color: Colors.text, fontSize: 13, lineHeight: 18 },
  pendingActions: { gap: 8, paddingRight: 4 },
  actionPill: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionPillDisabled: { opacity: 0.5 },
  actionPillText: { color: Colors.background, fontSize: 13, fontWeight: '700' },
  agentControlsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  agentControlsToggleText: { color: Colors.textDim, fontSize: 12, fontWeight: '600' },
  agentControlsPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  bypassButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 16,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.inputBackground,
  },
  bypassButtonActive: { backgroundColor: Colors.warning, borderColor: Colors.warning },
  bypassButtonText: { color: Colors.text, fontSize: 12, fontWeight: '700' },
  bypassButtonTextActive: { color: Colors.background },
  controlNotice: { color: Colors.textDim, fontSize: 12, flexShrink: 1 },
  controlNoticeError: { color: Colors.error },
  disconnectedBar: { backgroundColor: Colors.error, padding: 8, alignItems: 'center' },
  disconnectedText: { color: Colors.text, fontSize: 13 },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end', padding: 8,
    backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.surfaceBorder, gap: 8,
  },
  input: {
    flex: 1, backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: Colors.text, maxHeight: 100,
  },
  sendBtn: { backgroundColor: Colors.primary, width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingTop: 80 },
  emptyText: { fontSize: 16, color: Colors.muted },
  emptySubtext: { fontSize: 13, color: Colors.textDim },
});
