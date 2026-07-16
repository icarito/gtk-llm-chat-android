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
  Modal,
  Pressable,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useXmpp } from '@/xmpp/XmppContext';
import { XmppService } from '@/xmpp/XmppService';
import { setActiveChatJid } from '@/xmpp/notifications';
import { formatAgentActivity, parseAgentStatus } from '@/xmpp/agentStatus';
import { Colors } from '@/constants/theme';
import type { XmppButtonStyle, XmppInlineCommand, XmppMessage, XmppPendingAction } from '@/types/xmpp';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LAST_CHAT_KEY = '@gtk_llm_chat:last_chat_jid';

/** Color de fondo del botón según su estilo (paridad con Telegram/GTK). */
function pillBackgroundForStyle(style?: XmppButtonStyle): string {
  switch (style) {
    case 'success': return Colors.success;
    case 'danger': return Colors.error;
    case 'secondary': return Colors.secondary;
    case 'primary':
    default: return Colors.primary;
  }
}

/** Same message, seen twice: once live, once replayed from the archive. */
const DEDUPE_WINDOW_MS = 30_000;

/** How much of the conversation to show on open. The rest stays one tap away. */
const INITIAL_PAGE_SIZE = 30;
const OLDER_PAGE_SIZE = 30;

function runWhenIdle(task: () => void): () => void {
  const idle = (
    globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    }
  );
  if (idle.requestIdleCallback) {
    const handle = idle.requestIdleCallback(task);
    return () => idle.cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(task, 0);
  return () => clearTimeout(handle);
}

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

function pushStatusLabel(
  token: 'idle' | 'requesting' | 'ready' | 'denied' | 'error',
  registration: 'idle' | 'pending' | 'registered' | 'error',
): string {
  if (registration === 'registered') return 'Push: registrado';
  if (registration === 'pending') return 'Push: registrando';
  if (registration === 'error') return 'Push: error';
  if (token === 'ready') return 'Push: token';
  if (token === 'requesting') return 'Push: preparando';
  if (token === 'denied') return 'Push: sin permiso';
  if (token === 'error') return 'Push: error';
  return 'Push: pendiente';
}

function formatCount(value: number | string): string {
  try {
    const number = typeof value === 'string'
      ? parseInt(value.replace(/,/g, ''), 10)
      : value;
    if (!Number.isFinite(number)) return String(value);
    if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
    if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
    return String(number);
  } catch {
    return String(value);
  }
}

function formatCost(value: number | string): string {
  try {
    const number = typeof value === 'string'
      ? parseFloat(value.replace(/[$,]/g, ''))
      : value;
    if (!Number.isFinite(number)) return String(value);
    return number < 1 ? `$${number.toFixed(4)}` : `$${number.toFixed(2)}`;
  } catch {
    return String(value);
  }
}

export default function XmppChatScreen() {
  const { jid } = useLocalSearchParams<{ jid: string }>();
  const decodedJid = decodeURIComponent(jid || '');
  const {
    state,
    messages,
    pendingActions,
    pushStatus,
    contacts,
    sendMessage,
    answerPendingAction,
    setApprovalBypass,
    connect,
    isConfigured,
  } = useXmpp();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<XmppMessage[]>([]);
  const [rehydrating, setRehydrating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [agentControlsOpen, setAgentControlsOpen] = useState(false);
  const [bypassEnabled, setBypassEnabled] = useState(false);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const [availableCommands, setAvailableCommands] = useState<XmppInlineCommand[]>([]);
  const [loadingCommands, setLoadingCommands] = useState(false);
  const [commandBusyNode, setCommandBusyNode] = useState<string | null>(null);
  const [showPendingPopover, setShowPendingPopover] = useState(false);
  const [telemetry, setTelemetry] = useState<Record<string, unknown>>({});
  const flatListRef = useRef<FlatList<XmppMessage>>(null);
  const hasCachedHistoryRef = useRef(false);

  // Suppress local notifications while this chat is open
  useEffect(() => {
    setActiveChatJid(decodedJid);
    return () => setActiveChatJid(null);
  }, [decodedJid]);

  // Paint the cache immediately on open, then catch up with the archive.
  useEffect(() => {
    let cancelled = false;
    let cancelIdle: (() => void) | null = null;
    hasCachedHistoryRef.current = false;
    setHistory([]);
    setExhausted(false);
    setRehydrating(true);

    (async () => {
      try {
        const cached = await XmppService.loadCachedHistory(
          decodedJid,
          INITIAL_PAGE_SIZE,
          { restoreActions: false },
        );
        if (cancelled) return;
        hasCachedHistoryRef.current = cached.length > 0;
        setHistory(cached);
        cancelIdle = runWhenIdle(() => {
          XmppService.restoreCachedActions(decodedJid, INITIAL_PAGE_SIZE)
            .finally(() => {
              if (!cancelled) setRehydrating(false);
            });
        });
      } catch (error) {
        // Sin esto, un fallo aquí (p.ej. el cache SQLite no abrió) deja la
        // pantalla en blanco para siempre y sin rastro: el chat se ve como si
        // no tuviera historial en vez de mostrar que algo salió mal.
        console.warn('[xmpp-chat] loadCachedHistory failed', error);
      } finally {
        if (!cancelled && cancelIdle === null) setRehydrating(false);
      }
    })();

    return () => {
      cancelled = true;
      cancelIdle?.();
    };
  }, [decodedJid]);

  // Catch up when there is no cache. If cache exists, refresh MAM quietly
  // after initial render; the visible conversation is already usable.
  useEffect(() => {
    if (state !== 'online') return;
    let cancelled = false;
    const showSync = !hasCachedHistoryRef.current;
    let cancelIdle: (() => void) | null = null;
    if (showSync) setSyncing(true);

    const runSync = async () => {
      try {
        await XmppService.syncHistory(decodedJid);
        if (cancelled) return;
        const recent = await XmppService.loadCachedHistory(
          decodedJid,
          INITIAL_PAGE_SIZE,
          { restoreActions: false },
        );
        if (cancelled) return;
        hasCachedHistoryRef.current = recent.length > 0;
        setHistory((prev) => (prev.length > recent.length
          ? mergeMessages(prev, recent)  // user already paged further back
          : recent));
      } catch (error) {
        // Un MAM IQ que falla (timeout, stream error) o el cache SQLite roto
        // no debe dejar la conversación en blanco sin rastro — ver el mismo
        // catch en el efecto de arriba.
        console.warn('[xmpp-chat] syncHistory failed', error);
      } finally {
        if (!cancelled) setSyncing(false);
      }
    };

    if (showSync) {
      runSync();
    } else {
      cancelIdle = runWhenIdle(() => { runSync(); });
    }

    return () => {
      cancelled = true;
      cancelIdle?.();
    };
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
  const pendingGroups = useMemo(() => {
    const grouped = new Map<string, {
      id: string;
      timestamp: string;
      detail: string;
      actions: XmppPendingAction[];
    }>();

    for (const action of chatPendingActions) {
      const key = action.messageId || action.id;
      const existing = grouped.get(key);
      if (existing) {
        existing.actions.push(action);
      } else {
        grouped.set(key, {
          id: key,
          timestamp: action.timestamp,
          detail: action.detail,
          actions: [action],
        });
      }
    }

    return [...grouped.values()].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }, [chatPendingActions]);
  const visiblePending = pendingGroups[0] ?? null;
  const contact = useMemo(
    () => contacts.find((item) => item.jid === decodedJid),
    [contacts, decodedJid],
  );
  const agentStatus = useMemo(() => parseAgentStatus(contact?.status), [contact?.status]);

  // Telemetría por PEP (contexto, modelo, coste). Nos suscribimos a los eventos,
  // y además PEDIMOS el valor actual al abrir: los eventos sólo llegan cuando el
  // agente publica algo nuevo, así que uno que lleva rato quieto no emitiría nada
  // y la barra se quedaría vacía para siempre.
  useEffect(() => {
    const cached = XmppService.getAgentTelemetry(decodedJid);
    if (cached) setTelemetry(cached);
    const unsub = XmppService.onTelemetry((jid, data) => {
      if (jid === decodedJid) setTelemetry({ ...data });
    });
    XmppService.fetchAgentTelemetry(decodedJid);
    return () => { unsub(); };
  }, [decodedJid]);

  const contextFraction = useMemo(() => {
    const used = telemetry.context_used as number | undefined;
    const max = telemetry.context_max as number | undefined;
    if (used === undefined || !max) return null;
    return Math.max(0, Math.min(1, used / max));
  }, [telemetry]);

  const contextBarColor = useMemo(() => {
    const fraction = contextFraction;
    if (fraction === null) return Colors.primary;
    if (fraction > 0.9) return Colors.error;
    if (fraction > 0.75) return Colors.warning;
    return Colors.success;
  }, [contextFraction]);

  const contextLabel = useMemo(() => {
    const fraction = contextFraction;
    if (fraction === null) return null;
    const used = telemetry.context_used as number;
    const max = telemetry.context_max as number;
    return `Contexto: ${Math.round(fraction * 100)}% (${Math.round(used / 1000)}k / ${Math.round((max as number) / 1000)}k tokens)`;
  }, [contextFraction, telemetry]);

  const modelBadge = useMemo(() => {
    const model = telemetry.model as string | undefined;
    if (!model) return null;
    return String(model).split('/').pop() || model;
  }, [telemetry]);

  const sessionStats = useMemo(() => {
    const parts: string[] = [];
    const total = telemetry.tokens_total as number | undefined;
    const requests = telemetry.tokens_requests as number | undefined;
    if (total !== undefined) {
      parts.push(`Sesión: ${formatCount(total)} tok`);
      if (requests !== undefined) parts.push(`${requests} req`);
    }
    const cost = telemetry.cost;
    if (cost !== undefined) {
      parts.push(`Cost: ${formatCost(cost as number | string)}`);
    }
    return parts;
  }, [telemetry]);

  const statusDetails = useMemo(() => {
    const details: string[] = [];
    const pushLabel = pushStatusLabel(pushStatus.token, pushStatus.registration);
    if (pushLabel) details.push(pushLabel);
    if (sessionStats.length > 0) details.push(...sessionStats);
    return details;
  }, [pushStatus, sessionStats]);

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
    if (isConfigured && (state === 'disconnected' || state === 'offline')) {
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

  const handleRunCommand = useCallback(async (command: XmppInlineCommand) => {
    setCommandBusyNode(command.node);
    setControlNotice(null);
    try {
      const result = await XmppService.runAdhocCommand(command.jid || decodedJid, command.node);
      setControlNotice(result || `Comando ejecutado: ${command.name}`);
    } catch (err) {
      setControlNotice(String(err));
    } finally {
      setCommandBusyNode(null);
    }
  }, [decodedJid]);

  useEffect(() => {
    if (state !== 'online') {
      setAvailableCommands([]);
      return;
    }
    let cancelled = false;
    setLoadingCommands(true);
    XmppService.listAdhocCommands(decodedJid)
      .then((commands) => {
        if (!cancelled) setAvailableCommands(commands);
      })
      .catch(() => {
        if (!cancelled) setAvailableCommands([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCommands(false);
      });
    return () => { cancelled = true; };
  }, [decodedJid, state]);

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
          headerTitle: contact?.name || decodedJid,
          headerStyle: { backgroundColor: Colors.surface },
          headerTintColor: Colors.text,
          headerRight: () => (
            <View style={styles.headerRight}>
              <View
                style={[
                  styles.headerDot,
                  { backgroundColor: state === 'online' ? Colors.success : Colors.error },
                ]}
              />
              <Text style={styles.headerStatus}>
                {state === 'online' ? 'Conectado' : state === 'connecting' ? 'Conectando' : 'Desconectado'}
              </Text>
            </View>
          ),
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
              {modelBadge && (
                <View style={styles.modelBadge}>
                  <Text style={styles.modelBadgeText}>{modelBadge}</Text>
                </View>
              )}
            </View>
            {contextFraction !== null && (
              <View style={styles.contextBar}>
                <View style={[styles.contextFill, {
                  width: `${Math.round(contextFraction * 100)}%`,
                  backgroundColor: contextBarColor,
                }]} />
                {contextLabel && (
                  <Text style={styles.contextBarLabel} numberOfLines={1}>{contextLabel}</Text>
                )}
              </View>
            )}
            {statusDetails.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.statusMetrics}
              >
                {statusDetails.map((detail) => (
                  <Text key={detail} style={styles.statusMetric} numberOfLines={1}>
                    {detail}
                  </Text>
                ))}
              </ScrollView>
            )}
          </View>

          <View style={styles.statusFooter}>
            <Text style={styles.connectionLabel} numberOfLines={1}>
              {decodedJid}
            </Text>
            <TouchableOpacity
              style={styles.agentControlsToggle}
              onPress={() => setAgentControlsOpen((open) => !open)}
            >
              <Ionicons name="options-outline" size={16} color={Colors.textDim} />
              <Text style={styles.agentControlsToggleText}>Controles</Text>
              <Ionicons
                name={agentControlsOpen ? 'chevron-down' : 'chevron-forward'}
                size={14}
                color={Colors.textDim}
              />
            </TouchableOpacity>
          </View>

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
              {loadingCommands && (
                <View style={styles.commandLoadingRow}>
                  <ActivityIndicator size="small" color={Colors.primary} />
                  <Text style={styles.commandHint}>Cargando comandos XMPP...</Text>
                </View>
              )}
              {!loadingCommands && availableCommands.length > 0 && (
                <View style={styles.commandGrid}>
                  {availableCommands.map((command) => (
                    <TouchableOpacity
                      key={command.node}
                      style={styles.commandButton}
                      disabled={state !== 'online' || commandBusyNode !== null}
                      onPress={() => handleRunCommand(command)}
                    >
                      {commandBusyNode === command.node ? (
                        <ActivityIndicator size="small" color={Colors.background} />
                      ) : (
                        <Text style={styles.commandButtonText} numberOfLines={1}>{command.name}</Text>
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              {!loadingCommands && availableCommands.length === 0 && (
                <Text style={styles.commandHint}>Sin comandos ad-hoc disponibles para este contacto.</Text>
              )}
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

        {(rehydrating || syncing) && (
          <View style={styles.hydrationBar}>
            <ActivityIndicator size="small" color={Colors.primary} />
            <Text style={styles.hydrationText}>
              {rehydrating ? 'Rehidratando historial' : 'Sincronizando MAM'}
            </Text>
          </View>
        )}

        {visiblePending && (
          <View style={styles.pendingCard}>
            <View style={styles.pendingHeader}>
              <Text style={styles.pendingTitle}>
                {pendingGroups.length > 1
                  ? `Response needed (${pendingGroups.length})`
                  : 'Response needed'}
              </Text>
              <View style={styles.pendingHeaderRight}>
                <Text style={styles.pendingTime}>
                  {new Date(visiblePending.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
                {pendingGroups.length > 1 && (
                  <TouchableOpacity
                    style={styles.pendingCounter}
                    onPress={() => setShowPendingPopover(true)}
                  >
                    <Text style={styles.pendingCounterText}>{pendingGroups.length}</Text>
                  </TouchableOpacity>
                )}
                {visiblePending.detail ? (
                  <TouchableOpacity
                    style={styles.pendingInfoBtn}
                    onPress={() => setShowPendingPopover(true)}
                  >
                    <Ionicons name="information-circle-outline" size={18} color={Colors.textDim} />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
            <Text style={styles.pendingDetail} numberOfLines={2}>
              {visiblePending.detail}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pendingActions}>
              {visiblePending.actions.map((action) => (
                <TouchableOpacity
                  key={action.id}
                  style={[
                    styles.actionPill,
                    { backgroundColor: pillBackgroundForStyle(action.style) },
                    actionBusy === action.id && styles.actionPillDisabled,
                  ]}
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

        <Modal
          visible={showPendingPopover}
          animationType="fade"
          transparent
          onRequestClose={() => setShowPendingPopover(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setShowPendingPopover(false)}>
            <View style={styles.popoverContent}>
              <View style={styles.popoverHeader}>
                <Text style={styles.popoverTitle}>Respuestas pendientes</Text>
                <TouchableOpacity onPress={() => setShowPendingPopover(false)}>
                  <Ionicons name="close" size={20} color={Colors.textDim} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.popoverList}>
                {pendingGroups.map((group, index) => (
                  <View key={group.id} style={styles.popoverRow}>
                    <Text style={styles.popoverRowTitle}>
                      Pendiente {index + 1}
                    </Text>
                    {group.detail ? (
                      <Text style={styles.popoverRowDetail} numberOfLines={3}>
                        {group.detail}
                      </Text>
                    ) : null}
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pendingActions}>
                      {group.actions.map((action) => (
                        <TouchableOpacity
                          key={action.id}
                          style={[
                            styles.actionPill,
                            { backgroundColor: pillBackgroundForStyle(action.style) },
                            actionBusy === action.id && styles.actionPillDisabled,
                          ]}
                          disabled={state !== 'online' || actionBusy !== null}
                          onPress={() => {
                            setShowPendingPopover(false);
                            handleAnswerAction(action);
                          }}
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
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>

        {state !== 'online' && state !== 'connecting' && (
          <View style={styles.disconnectedBar}>
            <Text style={styles.disconnectedText}>
              {state === 'offline' ? 'Desconectado — reconectando...' : 'Desconectado'}
            </Text>
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
    marginHorizontal: 6,
    marginTop: 6,
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
  modelBadge: {
    backgroundColor: Colors.inputBackground,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginLeft: 4,
  },
  modelBadgeText: {
    color: Colors.primary,
    fontSize: 11,
    fontWeight: '700',
  },
  contextBar: {
    height: 6,
    backgroundColor: Colors.surfaceBorder,
    borderRadius: 3,
    overflow: 'hidden',
    position: 'relative',
  },
  contextFill: {
    height: '100%',
    backgroundColor: Colors.primary,
    borderRadius: 3,
    position: 'absolute',
    left: 0,
    top: 0,
  },
  contextBarLabel: {
    color: Colors.textDim,
    fontSize: 10,
    position: 'absolute',
    right: 4,
    top: -15,
  },
  statusFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 4,
    gap: 8,
  },
  connectionLabel: {
    color: Colors.textDim,
    fontSize: 11,
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  headerStatus: {
    color: Colors.textDim,
    fontSize: 12,
  },
  pendingHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pendingCounter: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.warning,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  pendingCounterText: {
    color: Colors.background,
    fontSize: 11,
    fontWeight: '800',
  },
  pendingInfoBtn: {
    padding: 2,
  },
  pendingPopover: {
    position: 'absolute',
    bottom: '100%',
    right: 0,
    marginBottom: 8,
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    minWidth: 280,
    maxHeight: 400,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  pendingPopoverItem: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
    gap: 6,
  },
  pendingPopoverDetail: {
    color: Colors.textDim,
    fontSize: 12,
    lineHeight: 17,
  },
  hydrationBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.surfaceBorder,
  },
  hydrationText: { color: Colors.textDim, fontSize: 12, fontWeight: '600' },
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
  commandLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  commandHint: {
    color: Colors.textDim,
    fontSize: 12,
    fontWeight: '600',
  },
  commandGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    width: '100%',
  },
  commandButton: {
    minHeight: 34,
    borderRadius: 17,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
  },
  commandButtonText: {
    color: Colors.background,
    fontSize: 12,
    fontWeight: '700',
    maxWidth: 180,
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
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  popoverContent: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    overflow: 'hidden',
  },
  popoverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  popoverTitle: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  popoverList: {
    maxHeight: '100%',
  },
  popoverRow: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
    gap: 6,
  },
  popoverRowTitle: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  popoverRowDetail: {
    color: Colors.textDim,
    fontSize: 12,
    lineHeight: 17,
  },
});
