import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react';
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
  Image,
  Linking,
  Alert,
  ToastAndroid,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, Stack, useFocusEffect } from 'expo-router';
import { useXmpp } from '@/xmpp/XmppContext';
import { XmppService, findDenyAction, pendingGroupLooksLikeApproval } from '@/xmpp/XmppService';
import { setActiveChatJid, dismissNotificationForJid } from '@/xmpp/notifications';
import { displayName, presenceColor } from '@/xmpp/presence';
import { pendingOutboundCount } from '@/xmpp/pendingCount';
import { formatAgentActivity, parseAgentStatus } from '@/xmpp/agentStatus';
import { Colors } from '@/constants/theme';
import type { XmppButtonStyle, XmppInlineCommand, XmppMessage, XmppPendingAction } from '@/types/xmpp';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  runOnJS,
  clamp,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useVoiceRecorder } from '@/xmpp/voiceRecorder';
import { isAudioUrl } from '@/xmpp/audioUtils';
import { Audio } from 'expo-av';
import { splitMarkdownTables, type MarkdownTable } from '@/xmpp/markdownTables';

const LAST_CHAT_KEY = '@gtk_llm_chat:last_chat_jid';
/** Ventana tras la última corrección XEP-0308 en la que la burbuja se
 *  considera "en streaming" (el gateway edita cada pocos segundos). */
const STREAMING_WINDOW_MS = 6000;

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)(\?|#|$)/i;
const TRAILING_URL_PUNCT_RE = /[.,;:!?)\]}]+$/;
const CODE_FENCE_RE = /```([^\n`]*)\n?([\s\S]*?)```/g;

function approvalTransportNotice(body: string): 'toast' | 'discard' | null {
  const text = body.trim().replace(/\s+/g, ' ');
  if (/^Command (submitted|expired)\.?$/i.test(text)) return 'toast';
  if (/^✅\s*Approval\s+(allow-once|allow-always|deny)\s+submitted\b/i.test(text)) {
    return 'toast';
  }
  if (/^✅\s*aprobado\s*[—-]/i.test(text)) return 'toast';
  if (/^❌?\s*Failed to submit approval\b/i.test(text)) return 'toast';
  if (/\bapproval already pending for session\b/i.test(text)) return 'toast';
  if (/^Recibido\s*[·.-]\s*preparando…?$/i.test(text)) return 'discard';
  if (/^Turno completado sin respuesta visible\.?$/i.test(text)) return 'discard';
  if (/Command approval requested/i.test(text) && /Approval:/i.test(text)) {
    return 'discard';
  }
  if (/```\s*```/.test(text) && !/🔒/.test(text)) {
    return 'discard';
  }
  return null;
}

type MessagePart =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string; language?: string };

function splitCodeFences(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  CODE_FENCE_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_FENCE_RE.exec(content)) !== null) {
    if (match.index > cursor) {
      parts.push({ type: 'text', value: content.slice(cursor, match.index) });
    }
    const language = (match[1] || '').trim().split(/\s+/)[0];
    parts.push({
      type: 'code',
      value: (match[2] || '').replace(/\n$/, ''),
      ...(language ? { language } : {}),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    parts.push({ type: 'text', value: content.slice(cursor) });
  }
  return parts.length ? parts : [{ type: 'text', value: content }];
}

// Ancho de borde/padding por celda (borderRightWidth + paddingHorizontal*2),
// tiene que coincidir con markdownTableCell más abajo — usado para calcular
// el ancho total real de la tabla sin necesitar onLayout async.
const TABLE_CELL_CHROME = 19;
// bubble.maxWidth (82%) - bubble.paddingHorizontal*2 (24) - listContent
// padding*2 (24) que ya se descuentan aparte via windowWidth * 0.82. Sólo
// el padding propio de la burbuja hace falta acá.
const BUBBLE_HORIZONTAL_PADDING = 24;

function MarkdownTableView({ table, isMine }: { table: MarkdownTable; isMine: boolean }) {
  const widths = table.headers.map((header, column) => Math.min(
    260,
    Math.max(100, ...[header, ...table.rows.map((row) => row[column] ?? '')]
      .map((cell) => cell.length * 8 + 24)),
  ));
  const tableWidth = widths.reduce((sum, w) => sum + w + TABLE_CELL_CHROME, 0);

  // Un ScrollView horizontal acá medía mal su altura dentro de la FlatList
  // (inverted) — la burbuja terminaba ocupando casi toda la pantalla desde
  // el primer render, no sólo al scrollear (bug de Android confirmado en
  // dispositivo, ver AGENTS.md). Mismo patrón que el swipe de selección de
  // MessageBubble: un Gesture.Pan + Animated.View, evitando el componente
  // que rompía el layout.
  //
  // viewportWidth se calcula, no se mide con onLayout: el contenedor no
  // puede medirse a sí mismo para decidir su propio ancho cuando su único
  // hijo (la tabla, con width: tableWidth fijo) es lo que determina su
  // tamaño natural — sería circular. bubble.maxWidth ya es 82% del ancho de
  // fila (ver styles.bubble/messageBubbleWrapper), así que el máximo real
  // disponible es ese mismo 82% menos el padding propio de la burbuja.
  const { width: windowWidth } = useWindowDimensions();
  const viewportWidth = windowWidth * 0.82 - BUBBLE_HORIZONTAL_PADDING;
  const translateX = useSharedValue(0);
  const maxScroll = Math.max(0, tableWidth - viewportWidth);
  const pan = useMemo(() => Gesture.Pan()
    .enabled(maxScroll > 0)
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onUpdate((event) => {
      'worklet';
      translateX.value = clamp(event.translationX, -maxScroll, 0);
    })
    // Sin onEnd: a diferencia del swipe-para-seleccionar, acá no hay una
    // acción que disparar al soltar — el scroll se queda donde el dedo lo
    // dejó, como cualquier ScrollView. .enabled(false) cuando la tabla
    // cabe entera (maxScroll 0): sin esto, este gesto seguía reclamando el
    // touch con umbral de 10px y bloqueaba el swipe-para-seleccionar de
    // MessageBubble (umbral 16px) sobre tablas que no necesitan scroll.
    , [maxScroll, translateX]);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={[styles.markdownTableScroll, { width: Math.min(tableWidth, viewportWidth) }]}>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.markdownTable, { width: tableWidth }, animatedStyle]}>
          {[table.headers, ...table.rows].map((row, rowIndex) => (
            <View key={`row-${rowIndex}`} style={styles.markdownTableRow}>
              {widths.map((width, column) => (
                <Text
                  key={`cell-${column}`}
                  selectable
                  style={[
                    styles.markdownTableCell,
                    rowIndex === 0 && styles.markdownTableHeader,
                    isMine && styles.messageTextMine,
                    { width, textAlign: table.align[column] ?? 'left' },
                  ]}
                >
                  {row[column] ?? ''}
                </Text>
              ))}
            </View>
          ))}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function MessageBody({ body, isMine }: { body: string; isMine: boolean }) {
  return (
    <View style={styles.messageBody}>
      {splitCodeFences(body).map((part, index) => {
        if (part.type === 'code') {
          return (
            <View key={`code-${index}`} style={styles.codeBlock}>
              <View style={styles.codeHeader}>
                <Text style={styles.codeLanguage} numberOfLines={1}>
                  {part.language || 'code'}
                </Text>
                <TouchableOpacity
                  style={styles.codeCopyButton}
                  onPress={() => Clipboard.setStringAsync(part.value)}
                  accessibilityRole="button"
                  accessibilityLabel="Copiar código"
                >
                  <Ionicons name="copy-outline" size={16} color={Colors.text} />
                </TouchableOpacity>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text selectable style={styles.codeText}>{part.value || ' '}</Text>
              </ScrollView>
            </View>
          );
        }
        if (!part.value.trim()) return null;
        return splitMarkdownTables(part.value).map((block, blockIndex) => (
          block.type === 'table' ? (
            <MarkdownTableView
              key={`table-${index}-${blockIndex}`}
              table={block.value}
              isMine={isMine}
            />
          ) : (
            <Text
              key={`text-${index}-${blockIndex}`}
              selectable
              selectionColor={isMine ? 'rgba(255,255,255,0.4)' : Colors.primary}
              style={[styles.messageText, isMine && styles.messageTextMine]}
            >
              {block.value}
            </Text>
          )
        ));
      })}
    </View>
  );
}

/**
 * Umbral de arrastre horizontal (px) para abrir el texto seleccionable.
 * activeOffsetX ya evita que dispare con el scroll vertical de la FlatList
 * (mismo patrón que stickyPanGesture, para la tarjeta de aprobaciones); esto
 * además evita que un tap con jitter mínimo la abra por accidente.
 */
const SWIPE_SELECT_THRESHOLD = 56;

/**
 * Envuelve la burbuja con un gesto de swipe lateral: selectable dentro de la
 * FlatList perdía contra el scroll (Gesture.Native + shouldActivateOnStart
 * tampoco lo resolvió sin arriesgar romper el scroll — ver AGENTS.md). En
 * vez de pelear por el mismo touch, un gesto DISTINTO (swipe, no long-press)
 * abre el texto en un TextInput fuera de la lista, donde la selección nativa
 * de Android sí es confiable.
 */
function MessageBubble({
  children,
  onSwipeSelect,
}: {
  children: ReactNode;
  onSwipeSelect: () => void;
}) {
  const translateX = useSharedValue(0);
  const pan = useMemo(() => Gesture.Pan()
    .activeOffsetX([-16, 16])
    .failOffsetY([-12, 12])
    .onUpdate((event) => {
      translateX.value = event.translationX;
    })
    .onEnd((event) => {
      if (Math.abs(event.translationX) > SWIPE_SELECT_THRESHOLD) {
        runOnJS(onSwipeSelect)();
      }
      translateX.value = withSpring(0);
    }), [onSwipeSelect, translateX]);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value * 0.4 }],
  }));

  return (
    <GestureDetector gesture={pan}>
      {/* El maxWidth: '82%' vive ACÁ, no en la burbuja: este Animated.View
          es el hijo directo de messageRow (flexDirection: row), así que su
          82% se calcula contra el ancho real de la fila. Si el maxWidth
          estuviera en la burbuja (hija de este wrapper), el 82% se
          calcularía contra el ancho ya encogido del wrapper — el bug de las
          burbujas angostas. `alignItems` según el lado lo pone el padre vía
          justifyContent; acá sólo se limita el ancho. */}
      <Animated.View style={[styles.messageBubbleWrapper, animatedStyle]}>{children}</Animated.View>
    </GestureDetector>
  );
}

/** ¿El adjunto es una imagen? (por extensión del link de XEP-0363). */
function isImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url);
}

function firstImageUrl(content?: string | null): string | null {
  if (!content) return null;
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(content)) !== null) {
    const url = match[0].replace(TRAILING_URL_PUNCT_RE, '');
    if (isImageUrl(url)) return url;
  }
  return null;
}

function contentWithoutAttachmentUrl(content: string, imageUrl: string | null): string {
  if (!imageUrl) return content;
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(content)) !== null) {
    const url = match[0].replace(TRAILING_URL_PUNCT_RE, '');
    if (url !== imageUrl) continue;
    const stripped = `${content.slice(0, match.index)}${content.slice(match.index + match[0].length)}`
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .replace(/\s+[)\]}]+(?=\s|$)/g, '')
      .replace(/^[ \t]+|[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return stripped.replace(/^\[Photo\]\s*[^:\n]*:\s*$/i, '').trim();
  }
  return content;
}

/** Nombre de archivo legible a partir del link del adjunto. */
function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const name = decodeURIComponent(path.split('/').pop() || '');
    return name || url;
  } catch {
    return url.split('/').pop() || url;
  }
}

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

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function AudioBubble({ url, duration }: { url: string; duration?: number | null }) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [soundDuration, setSoundDuration] = useState(duration ?? 0);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
    };
  }, []);

  const handleToggle = useCallback(async () => {
    if (loading || error) return;

    if (playing && soundRef.current) {
      await soundRef.current.pauseAsync();
      setPlaying(false);
      return;
    }

    if (soundRef.current) {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        });
        const status = await soundRef.current.playAsync();
        setPlaying(status.isLoaded);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    setLoading(true);
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      });
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true, progressUpdateIntervalMillis: 200 },
        (status) => {
          if (!status.isLoaded) return;
          if (status.didJustFinish) {
            setPlaying(false);
            setPosition(0);
          } else if (status.isPlaying) {
            setPosition(status.positionMillis / 1000);
            if (status.durationMillis && !duration) {
              setSoundDuration(status.durationMillis / 1000);
            }
          }
        },
      );
      soundRef.current = newSound;
      setPlaying(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [url, playing, loading, error, duration]);

  const icon = error ? 'alert-circle' : playing ? 'pause' : 'play';
  const color = error ? Colors.error : Colors.primary;
  const durationLabel = soundDuration > 0
    ? ` / ${formatDuration(soundDuration)}`
    : '';
  const posLabel = playing ? formatDuration(position) : '';

  return (
    <TouchableOpacity style={styles.audioBubble} onPress={handleToggle}>
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[styles.audioLabel, error && { color: Colors.error }]}>
        {error ? error : playing ? `${posLabel}${durationLabel}` : `Voz${durationLabel}`}
      </Text>
    </TouchableOpacity>
  );
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
  const [attaching, setAttaching] = useState(false);
  const [agentControlsOpen, setAgentControlsOpen] = useState(false);
  const [bypassEnabled, setBypassEnabled] = useState(false);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const [availableCommands, setAvailableCommands] = useState<XmppInlineCommand[]>([]);
  const [loadingCommands, setLoadingCommands] = useState(false);
  const [commandBusyNode, setCommandBusyNode] = useState<string | null>(null);
  const [showPendingPopover, setShowPendingPopover] = useState(false);
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<Record<string, unknown>>({});
  const [toolBubbles, setToolBubbles] = useState<XmppMessage[]>([]);
  const flatListRef = useRef<FlatList<XmppMessage>>(null);
  const followsLatestRef = useRef(true);
  const activeToolBubbleRef = useRef<string | null>(null);
  const hasCachedHistoryRef = useRef(false);

  useEffect(() => {
    setToolBubbles([]);
    activeToolBubbleRef.current = null;
    followsLatestRef.current = true;
  }, [decodedJid]);

  const voice = useVoiceRecorder();

  // Suppress local notifications while this chat is open, and clear the ones
  // already in the tray for this conversation (they are read now).
  useEffect(() => {
    setActiveChatJid(decodedJid);
    dismissNotificationForJid(decodedJid).catch(() => {});
    return () => setActiveChatJid(null);
  }, [decodedJid]);

  // Bump que fuerza refetch de telemetría y comandos: al volver a enfocar la
  // pantalla y cuando el agente pasa de offline a conectado (reinicio del
  // gateway). Sin esto, estado/estadísticas/comandos quedaban con lo que
  // hubiera al montar — la "inconsistencia" clásica al volver a un chat.
  const [refreshTick, setRefreshTick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setRefreshTick((tick) => tick + 1);
    }, []),
  );

  // Paint the cache immediately on open, then catch up with the archive.
  //
  // Sólo depende de decodedJid, NO de refreshTick: éste último también sube
  // al recuperar foco (useFocusEffect de arriba) y al reconectar, y ese
  // disparo es para refrescar telemetría/comandos (efectos de más abajo),
  // no para releer el historial. Si este efecto también corriera ahí, el
  // setHistory([]) de abajo vaciaba la lista visible en cada vuelta a la
  // pantalla — el catch-up real (mensajes nuevos llegados mientras no había
  // foco) ya lo cubre el efecto de sync con MAM, que hace merge sin vaciar.
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
  }, [decodedJid, state, refreshTick]);

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
  const liveMsgs = useMemo(
    () => messages.get(decodedJid) || [],
    [decodedJid, messages],
  );
  const sortedMsgs = mergeMessages(history, liveMsgs, toolBubbles)
    .filter((message) => approvalTransportNotice(message.body) === null);
  const msgCount = sortedMsgs.length;
  const toastedTransportIds = useRef(new Set<string>());

  useEffect(() => {
    for (const message of liveMsgs) {
      if (message.direction !== 'in') continue;
      if (approvalTransportNotice(message.body) !== 'toast') continue;
      if (toastedTransportIds.current.has(message.id)) continue;
      toastedTransportIds.current.add(message.id);
      if (Platform.OS === 'android') {
        ToastAndroid.show(message.body.trim(), ToastAndroid.SHORT);
      }
    }
  }, [liveMsgs]);
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
      detailFull?: string;
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
          ...(action.detailFull ? { detailFull: action.detailFull } : {}),
          actions: [action],
        });
      }
    }

    return [...grouped.values()].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }, [chatPendingActions]);
  const visiblePending = pendingGroups[0] ?? null;
  const visiblePendingIsApproval = useMemo(
    () => (visiblePending
      ? pendingGroupLooksLikeApproval(
        visiblePending.detailFull ?? visiblePending.detail,
        visiblePending.actions,
      )
      : false),
    [visiblePending],
  );
  const contact = useMemo(
    () => contacts.find((item) => item.jid === decodedJid),
    [contacts, decodedJid],
  );
  const agentStatus = useMemo(() => parseAgentStatus(contact?.status), [contact?.status]);

  // PEP tool activity is UI telemetry, not an archive message. Mirror GTK by
  // keeping one mutable bubble while a tool is active, then retaining the
  // completed bubble as a local record. It never enters MAM and never causes a
  // second notification or a second agent turn.
  useEffect(() => {
    const tool = String(telemetry.tool ?? agentStatus.tool ?? '').trim();
    const isBusy = contact?.presence === 'dnd'
      || ['processing', 'busy'].includes(agentStatus.activity.trim().toLowerCase());
    if (!tool || !isBusy) {
      // PEP confirma que el turno terminó: si la burbuja local seguía activa
      // (nunca hubo una corrección XEP-0308 real que la reemplazara, p.ej. el
      // agente respondió sin texto o la corrección se perdió), se retira acá
      // en vez de quedar pegada indefinidamente mostrando la última
      // herramienta usada — mismo criterio que GTK (_remove_orphaned_progress_seeds).
      const staleId = activeToolBubbleRef.current;
      if (staleId) {
        setToolBubbles((items) => items.filter((item) => item.id !== staleId));
      }
      activeToolBubbleRef.current = null;
      return;
    }

    const body = `🛠️ Usando herramienta: ${tool}`;
    const activeId = activeToolBubbleRef.current;
    if (activeId) {
      setToolBubbles((items) => items.map((item) => (
        item.id === activeId
          ? { ...item, body, correctedAtMs: Date.now() }
          : item
      )));
      return;
    }

    const id = `local-tool-${Date.now()}`;
    activeToolBubbleRef.current = id;
    setToolBubbles((items) => [...items, {
      id,
      from: decodedJid,
      to: '',
      type: 'chat',
      body,
      timestamp: new Date().toISOString(),
      direction: 'in',
      isGroup: false,
      correctedAtMs: Date.now(),
    }]);
  }, [agentStatus.activity, agentStatus.tool, contact?.presence, decodedJid, telemetry.tool]);

  // El agente volvió a conectarse (reinicio del gateway): su set de comandos y
  // su telemetría pueden haber cambiado. Sólo dispara en la transición
  // offline→conectado, no en cada cambio de presencia (available↔dnd es ruido
  // constante mientras trabaja).
  const prevPresenceRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevPresenceRef.current;
    const current = contact?.presence;
    prevPresenceRef.current = current;
    if (prev === 'offline' && current && current !== 'offline') {
      setRefreshTick((tick) => tick + 1);
    }
  }, [contact?.presence]);

  // Telemetría por PEP (contexto, modelo, coste). Nos suscribimos a los eventos,
  // y además PEDIMOS el valor actual al abrir: los eventos sólo llegan cuando el
  // agente publica algo nuevo, así que uno que lleva rato quieto no emitiría nada
  // y la barra se quedaría vacía para siempre.
  //
  // Depende también de `state`: al abrir esta pantalla directo desde un arranque
  // en frío (navegación automática al último chat, o desde una notificación),
  // el componente monta en el mismo tick en que la conexión pasa a 'online' —
  // pedir el IQ ANTES de eso no sirve (fetchAgentTelemetry se aborta si no hay
  // conexión), y como el efecto sólo corría una vez, la pantalla se quedaba con
  // lo cacheado en memoria (potencialmente viejo) hasta salir y volver a entrar.
  useEffect(() => {
    const cached = XmppService.getAgentTelemetry(decodedJid);
    if (cached) setTelemetry(cached);
    // El nodo PEP persiste el último item publicado (pubsub#persist_items,
    // max_items=1): al reconectar tras un reinicio del gateway, el servidor
    // puede reenviar ese item VIEJO por la suscripción -- de una sesión
    // anterior del agente, con otro modelo/contexto -- antes de que el propio
    // gateway alcance a republicar el valor real (lo hace casi al arrancar,
    // pero no hay garantía de orden entre ambos). Marcamos el fetch explícito
    // como la fuente de verdad reciente: si justo después llega un evento en
    // vivo con OTRO modelo, es ese residuo, y repetimos el fetch para
    // asentarnos en el valor bueno en vez de quedarnos con el viejo.
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let trustedModel: string | undefined;
    let fetchSettled = false;
    const unsub = XmppService.onTelemetry((jid, data) => {
      if (jid !== decodedJid) return;
      const model = data.model as string | undefined;
      if (fetchSettled && trustedModel && model && model !== trustedModel) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          if (state === 'online') XmppService.fetchAgentTelemetry(decodedJid);
        }, 3000);
      } else {
        trustedModel = model ?? trustedModel;
      }
      setTelemetry({ ...data });
    });
    if (state === 'online') {
      XmppService.fetchAgentTelemetry(decodedJid).then(() => {
        fetchSettled = true;
      });
    }
    return () => {
      unsub();
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [decodedJid, state, refreshTick]);

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
  const latestRenderToken = inverted.length > 0
    ? `${inverted[0]!.id}\0${inverted[0]!.body}`
    : '';

  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // In an inverted FlatList offset 0 is the newest edge. Once the user
      // moves away, incoming corrections must not pull them back down.
      followsLatestRef.current = event.nativeEvent.contentOffset.y <= 48;
    },
    [],
  );

  useEffect(() => {
    if (!followsLatestRef.current || inverted.length === 0) return;
    const frame = requestAnimationFrame(() => {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [inverted.length, latestRenderToken]);

  // Mensajes tuyos que el agente aún no ha contestado. Es optimista y local:
  // se enciende al enviar, sin esperar a que el servidor publique presencia.
  const pendingCount = useMemo(() => pendingOutboundCount(sortedMsgs), [sortedMsgs]);

  // Ámbar sólo mientras el agente todavía no acusa trabajo: en cuanto pasa a
  // dnd/busy manda su propio estado ("Trabajando", "Herramienta: exec"), que
  // dice más que nuestra cuenta local.
  const agentWorking = contact?.presence === 'dnd'
    || ['processing', 'busy'].includes(agentStatus.activity.trim().toLowerCase())
    || Boolean(agentStatus.tool);
  const awaitingReply = pendingCount > 0 && !agentWorking;

  // XEP-0085: "escribiendo…" del contacto.
  const [peerTyping, setPeerTyping] = useState(() => XmppService.isTyping(decodedJid));
  useEffect(() => {
    setPeerTyping(XmppService.isTyping(decodedJid));
    const unsub = XmppService.onTypingChange((jid, typing) => {
      if (jid === decodedJid) setPeerTyping(typing);
    });
    return () => { unsub(); };
  }, [decodedJid]);

  // Avatar del contacto (XEP-0084, cacheado por el servicio) para el header.
  const [peerAvatar, setPeerAvatar] = useState<string | null>(
    () => XmppService.getAvatarUri(decodedJid),
  );
  useEffect(() => {
    setPeerAvatar(XmppService.getAvatarUri(decodedJid));
    XmppService.fetchAvatar(decodedJid).catch(() => {});
    const unsub = XmppService.onAvatarChange((jid, uri) => {
      if (jid === decodedJid) setPeerAvatar(uri);
    });
    return () => { unsub(); };
  }, [decodedJid]);

  // Afordancia de streaming: mientras una burbuja siga recibiendo
  // correcciones XEP-0308 (ventana de 6s), se pinta "en curso". El tick solo
  // corre mientras haya streaming activo, para no re-renderizar en vano.
  const [nowTick, setNowTick] = useState(() => Date.now());
  // renderMessage (más abajo) NO tiene nowTick en sus deps de useCallback a
  // propósito — recrearlo cada 2s rompía la selección de texto (ver
  // AGENTS.md). Pero eso significa que su closure queda con el nowTick
  // CONGELADO del momento en que se creó: sin esta ref, isStreaming se
  // calculaba siempre contra ese valor viejo y una burbuja resuelta hace
  // rato se quedaba pintada como "en curso" para siempre, en vez de
  // apagarse a los 6s. La ref sí se lee "en vivo" dentro del closure porque
  // .current es mutable — no depende de que React vuelva a crear la función.
  const nowTickRef = useRef(nowTick);
  nowTickRef.current = nowTick;
  const streamingActive = useMemo(
    () => sortedMsgs.some(
      (m) => m.correctedAtMs !== undefined && nowTick - m.correctedAtMs < STREAMING_WINDOW_MS,
    ),
    [sortedMsgs, nowTick],
  );
  useEffect(() => {
    if (!streamingActive) return;
    const timer = setInterval(() => setNowTick(Date.now()), 2000);
    return () => clearInterval(timer);
  }, [streamingActive]);

  // Persist last visited chat
  useEffect(() => {
    AsyncStorage.setItem(LAST_CHAT_KEY, decodedJid).catch(() => {});
  }, [decodedJid]);

  // Auto-connect al entrar sin conexión. UN intento por caída: si falla, el
  // backoff del servicio (scheduleReconnect) es quien reintenta — relanzar
  // desde aquí en cada cambio de estado creaba un bucle connecting→offline al
  // volver desde una notificación, peleando con el reconnect del AppState.
  const autoConnectAttemptedRef = useRef(false);
  useEffect(() => {
    if (!isConfigured) return;
    if (state !== 'disconnected' && state !== 'offline') {
      autoConnectAttemptedRef.current = false;
      return;
    }
    if (autoConnectAttemptedRef.current) return;
    autoConnectAttemptedRef.current = true;
    connect('', '', '', '').catch(() => {});
  }, [isConfigured, state, connect]);

  // XEP-0085 saliente: composing al teclear (re-emitido cada 8s como máximo),
  // paused al vaciar el campo. El <active/> del envío lo pone el servicio.
  const lastComposingSentRef = useRef(0);
  const handleInputChange = useCallback((text: string) => {
    setInput(text);
    const now = Date.now();
    if (text.trim()) {
      if (now - lastComposingSentRef.current > 8000) {
        lastComposingSentRef.current = now;
        XmppService.sendChatState(decodedJid, 'composing');
      }
    } else if (lastComposingSentRef.current > 0) {
      lastComposingSentRef.current = 0;
      XmppService.sendChatState(decodedJid, 'paused');
    }
  }, [decodedJid]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput('');
    followsLatestRef.current = true;
    lastComposingSentRef.current = 0;
    // sendMessage publishes the outgoing message to the service's map and
    // caches it — no local copy needed here.
    try {
      await sendMessage(decodedJid, trimmed, 'chat');
    } catch (e) {
      // ignore
    }
  }, [input, decodedJid, sendMessage]);

  /** Elige un archivo y lo sube por XEP-0363 (el link se manda como OOB). */
  const handleAttach = useCallback(async () => {
    if (attaching) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      const asset = picked.assets?.[0];
      if (!asset) return;
      setAttaching(true);
      // fetch(uri).blob() lee el archivo sin necesitar expo-file-system.
      const response = await fetch(asset.uri);
      const blob = await response.blob();
      await XmppService.sendFile(
        decodedJid,
        blob,
        asset.name || 'file',
        asset.mimeType || 'application/octet-stream',
        'chat',
      );
    } catch (e) {
      Alert.alert(
        'No se pudo enviar el archivo',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setAttaching(false);
    }
  }, [attaching, decodedJid]);

  /** Graba voz → sube por XEP-0363 → envía el link como OOB. */
  const handleVoicePressIn = useCallback(async () => {
    await voice.startRecording();
  }, [voice]);

  const handleVoicePressOut = useCallback(async () => {
    if (voice.recordingState === 'holding') {
      const cap = await voice.stopRecording();
      if (cap) {
        voice.setUploading();
        try {
          const response = await fetch(cap.fileUri);
          const blob = await response.blob();
          await XmppService.sendFile(
            decodedJid,
            blob,
            `voice_${Date.now()}.m4a`,
            cap.mimeType,
            'chat',
          );
          voice.reset();
        } catch (e) {
          voice.setFailed(e instanceof Error ? e.message : String(e));
        }
      }
    }
  }, [voice, decodedJid]);

  const handleAnswerAction = useCallback(async (action: XmppPendingAction) => {
    setActionBusy(action.id);
    try {
      await answerPendingAction(action.id);
    } catch (err) {
      // Sin este catch la excepción moría como unhandled rejection: el botón
      // se rehabilitaba por el finally pero el usuario no sabía que su
      // decisión no llegó. XmppService ya revirtió `submitted`, así que la
      // card vuelve a ser accionable y el aviso explica por qué.
      const notice = String(err);
      if (Platform.OS === 'android') ToastAndroid.show(notice, ToastAndroid.SHORT);
      else setControlNotice(notice);
    } finally {
      setActionBusy(null);
    }
  }, [answerPendingAction]);

  // ── Gestos de la tarjeta sticky ──
  // Arrastrar hacia arriba abre el detalle completo; arrastrar hacia el
  // costado deniega. El objetivo es poder resolver una aprobación sin apuntar
  // a un botón concreto, que en una tarjeta al pie de pantalla es incómodo.
  const stickyTranslateX = useSharedValue(0);
  const stickyTranslateY = useSharedValue(0);

  const denyAction = useMemo(
    () => (visiblePending ? findDenyAction(visiblePending.actions) : null),
    [visiblePending],
  );

  const canActOnSticky = state === 'online' && actionBusy === null;

  const handleSwipeDeny = useCallback(() => {
    if (!denyAction || denyAction.submitted || !canActOnSticky) return;
    handleAnswerAction(denyAction);
  }, [denyAction, canActOnSticky, handleAnswerAction]);

  const stickyPanGesture = useMemo(() => Gesture.Pan()
    .activeOffsetX([-16, 16])
    .activeOffsetY([-16, 16])
    .onUpdate((event) => {
      // Solo se sigue el eje dominante, para que un arrastre diagonal no
      // parezca que va a disparar las dos cosas a la vez.
      if (Math.abs(event.translationX) > Math.abs(event.translationY)) {
        stickyTranslateX.value = denyAction ? event.translationX : 0;
        stickyTranslateY.value = 0;
      } else {
        stickyTranslateY.value = Math.min(0, event.translationY);
        stickyTranslateX.value = 0;
      }
    })
    .onEnd((event) => {
      const horizontal = Math.abs(event.translationX) > Math.abs(event.translationY);
      if (horizontal && denyAction && Math.abs(event.translationX) > 120) {
        runOnJS(handleSwipeDeny)();
      } else if (!horizontal && event.translationY < -48) {
        runOnJS(setShowPendingPopover)(true);
      }
      stickyTranslateX.value = withSpring(0);
      stickyTranslateY.value = withSpring(0);
    }), [denyAction, handleSwipeDeny, stickyTranslateX, stickyTranslateY]);

  const stickyAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: stickyTranslateX.value },
      { translateY: stickyTranslateY.value },
    ],
  }));

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
      const notice = result || `Comando ejecutado: ${command.name}`;
      if (Platform.OS === 'android') ToastAndroid.show(notice, ToastAndroid.SHORT);
      else setControlNotice(notice);
    } catch (err) {
      const notice = String(err);
      if (Platform.OS === 'android') ToastAndroid.show(notice, ToastAndroid.SHORT);
      else setControlNotice(notice);
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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setLoadingCommands(true);
    const fetchCommands = (attempt: number) => {
      XmppService.listAdhocCommands(decodedJid)
        .then((commands) => {
          if (cancelled) return;
          setAvailableCommands(commands);
          // Un disco vacío recién conectados suele ser el gateway todavía
          // arrancando, no "este agente no tiene comandos": un único reintento
          // corto cubre esa ventana sin martillar el servidor.
          if (commands.length === 0 && attempt === 0) {
            retryTimer = setTimeout(() => fetchCommands(1), 4000);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setAvailableCommands([]);
          if (attempt === 0) {
            retryTimer = setTimeout(() => fetchCommands(1), 4000);
          }
        })
        .finally(() => {
          if (!cancelled) setLoadingCommands(false);
        });
    };
    fetchCommands(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [decodedJid, state, refreshTick]);

  const handleRetry = useCallback((id: string) => {
    XmppService.retryMessage(decodedJid, id).catch(() => {
      if (Platform.OS === 'android') {
        ToastAndroid.show('Sin conexión — no se pudo reenviar', ToastAndroid.SHORT);
      }
    });
  }, [decodedJid]);

  const renderMessage = useCallback(
    ({ item }: { item: XmppMessage }) => {
      const isMine = item.direction === 'out';
      const attachmentUrl = item.oobUrl || firstImageUrl(item.body);
      const visibleBody = contentWithoutAttachmentUrl(item.body, attachmentUrl);
      const isStreaming = !isMine
        && item.correctedAtMs !== undefined
        && nowTickRef.current - item.correctedAtMs < STREAMING_WINDOW_MS;
      const audioUrl = isAudioUrl(attachmentUrl) ? attachmentUrl
        : isAudioUrl(item.body) ? item.body.match(URL_RE)?.[0]?.replace(TRAILING_URL_PUNCT_RE, '') || null
          : null;
      const isToolActivity = !isMine && /^🛠️\s+Usando herramienta:/i.test(visibleBody);

      return (
        <View style={[styles.messageRow,
          isMine ? styles.messageRowRight : styles.messageRowLeft]}>
          <MessageBubble onSwipeSelect={() => {
            if (visibleBody) setSelectableText(visibleBody);
          }}>
            <View
              style={[
                styles.bubble,
                isMine ? styles.bubbleRight : styles.bubbleLeft,
                isStreaming && styles.bubbleStreaming,
              ]}
            >
              {!isMine && item.type === 'groupchat' && (
                <Text style={styles.senderName}>{item.from.split('/')[1] || item.from}</Text>
              )}
              {attachmentUrl ? (
                audioUrl ? (
                  <AudioBubble url={audioUrl} duration={item.attachmentDuration} />
                ) : isImageUrl(attachmentUrl) ? (
                  // Adjunto de imagen: preview tocable que abre el original.
                  <TouchableOpacity onPress={() => Linking.openURL(attachmentUrl)}>
                    <Image
                      source={{ uri: attachmentUrl }}
                      style={styles.attachmentImage}
                      resizeMode="contain"
                    />
                  </TouchableOpacity>
                ) : (
                  // Otro tipo de archivo: fila con icono + nombre, abre el link.
                  <TouchableOpacity
                    style={styles.attachmentFile}
                    onPress={() => Linking.openURL(attachmentUrl)}
                  >
                    <Ionicons name="document-outline" size={18} color={Colors.primary} />
                    <Text style={styles.attachmentFileName} numberOfLines={1}>
                      {fileNameFromUrl(attachmentUrl)}
                    </Text>
                  </TouchableOpacity>
                )
              ) : null}
              {/* El body de un adjunto suele repetir la URL o una etiqueta genérica. */}
              {visibleBody ? (
                isToolActivity ? (
                  <ScrollView
                    style={styles.toolOutputScroll}
                    nestedScrollEnabled
                    showsVerticalScrollIndicator
                  >
                    <MessageBody body={visibleBody} isMine={isMine} />
                  </ScrollView>
                ) : (
                  <MessageBody body={visibleBody} isMine={isMine} />
                )
              ) : null}
              <View style={styles.bubbleFooter}>
                {isStreaming && (
                  <ActivityIndicator size={12} color={Colors.primary} />
                )}
                <Text style={[styles.timestamp, isMine && styles.timestampMine]}>
                  {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {isMine && item.sendState === 'sent' ? ' ✓' : ''}
                  {isMine && item.sendState === 'pending' ? ' …' : ''}
                </Text>
              </View>
              {isMine && item.sendState === 'failed' && (
                <TouchableOpacity onPress={() => handleRetry(item.id)}>
                  <Text style={styles.sendFailedText}>⚠ No enviado — tocar para reintentar</Text>
                </TouchableOpacity>
              )}
            </View>
          </MessageBubble>
        </View>
      );
    },
    // nowTick NO va en las deps a propósito: recrear renderItem cada 2s
    // (mientras hay streaming activo) hacía que FlatList remontara las
    // celdas visibles y cancelara cualquier selección de texto en curso —
    // exactamente el bug documentado en CLAUDE.md ("la selección de texto
    // se desmonta con cada re-render"). Tampoco entra en `extraData` (sigue
    // siendo solo msgCount): eso también fuerza a FlatList a repintar las
    // celdas visibles. Costo aceptado: el borde/spinner de "streaming en
    // curso" puede tardar hasta el próximo evento real en apagarse en vez de
    // desvanecerse exactamente a los 6s — selección de texto confiable pesa
    // más que esa precisión visual.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleRetry],
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.headerTitleRow}>
              {peerAvatar ? (
                <Image source={{ uri: peerAvatar }} style={styles.headerAvatar} />
              ) : (
                <View style={[styles.headerAvatar, styles.headerAvatarFallback]}>
                  <Ionicons name="person" size={14} color={Colors.textDim} />
                </View>
              )}
              <Text style={styles.headerTitleText} numberOfLines={1}>
                {displayName(decodedJid, contact?.name)}
              </Text>
            </View>
          ),
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
        {/* Una sola línea, como en GTK: el detalle vive tras "Controles".
            La barra de contexto se dibuja como hairline bajo la fila. */}
        <View style={styles.agentToolbar}>
          <TouchableOpacity
            style={styles.statusStrip}
            activeOpacity={0.7}
            onPress={() => setAgentControlsOpen((open) => !open)}
          >
            <View
              style={[
                styles.statusDot,
                { backgroundColor: awaitingReply ? Colors.warning : presenceColor(contact?.presence ?? 'offline') },
              ]}
            />
            <Text
              style={[styles.statusActivity, awaitingReply && styles.statusActivityPending]}
              numberOfLines={1}
            >
              {awaitingReply
                // "Por procesar" no aclaraba quién procesa qué — esto es
                // "le mandaste esto y el agente todavía no contestó", no
                // sobre entrega XMPP ni sobre acciones tuyas pendientes
                // (eso es la tarjeta de más abajo, un concepto distinto).
                ? (pendingCount === 1
                  ? 'Esperando respuesta del agente'
                  : `Esperando respuesta del agente (${pendingCount} mensajes)`)
                : formatAgentActivity(agentStatus.activity)}
            </Text>
            {modelBadge && (
              <Text style={styles.modelBadgeText} numberOfLines={1}>{modelBadge}</Text>
            )}
            <View style={styles.statusSpacer} />
            {contextFraction !== null && (
              <Text style={[styles.contextPercent, { color: contextBarColor }]}>
                {Math.round(contextFraction * 100)}%
              </Text>
            )}
            <Ionicons
              name={agentControlsOpen ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={Colors.textDim}
            />
          </TouchableOpacity>


          {agentControlsOpen && (
            <View style={styles.agentControlsPanel}>
              <Text style={styles.connectionLabel} numberOfLines={1}>
                {decodedJid}
              </Text>
              {(contextLabel || statusDetails.length > 0) && (
                <View style={styles.statusMetrics}>
                  {contextLabel && (
                    <Text style={styles.statusMetric} numberOfLines={1}>{contextLabel}</Text>
                  )}
                  {statusDetails.map((detail) => (
                    <Text key={detail} style={styles.statusMetric} numberOfLines={1}>
                      {detail}
                    </Text>
                  ))}
                </View>
              )}
              <View style={styles.bypassRow}>
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
              </View>
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
          // streamingActive (booleano, cambia sólo 2 veces por turno: al
          // empezar y al terminar) fuerza a FlatList a repintar las celdas
          // visibles justo cuando el streaming termina — sin esto, la última
          // burbuja quedaba marcada "en curso" para siempre: nowTickRef ya
          // tenía el valor correcto, pero nada le pedía a FlatList que
          // volviera a invocar renderItem para leerlo. NO usar nowTick
          // directo acá (cambia cada 2s): repintaría todas las celdas
          // visibles en cada tick, mismo bug que ya rompía la selección.
          extraData={[msgCount, streamingActive]}
          onScroll={handleListScroll}
          scrollEventThrottle={32}
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

        {peerTyping && !streamingActive && (
          <View style={styles.typingRow}>
            <ActivityIndicator size={12} color={Colors.textDim} />
            <Text style={styles.typingText}>escribiendo…</Text>
          </View>
        )}

        {(rehydrating || syncing) && (
          <View style={styles.hydrationBar}>
            <ActivityIndicator size="small" color={Colors.primary} />
            <Text style={styles.hydrationText}>
              {rehydrating ? 'Rehidratando historial' : 'Sincronizando MAM'}
            </Text>
          </View>
        )}

        {visiblePending && (
          <GestureDetector gesture={stickyPanGesture}>
          <Animated.View style={[
            styles.pendingCard,
            visiblePendingIsApproval && styles.pendingCardApproval,
            stickyAnimatedStyle,
          ]}>
            <View style={styles.stickyGrabber} />
            <View style={styles.pendingHeader}>
              {visiblePendingIsApproval && (
                <Ionicons name="shield-checkmark-outline" size={16} color={Colors.warning} />
              )}
              <Text style={styles.pendingTitle}>
                {/* "Se requiere aprobación" (autorizar/denegar una acción del
                    agente) vs "Respuesta pendiente" (una pregunta cualquiera)
                    — mismo criterio que GTK (_actions_look_like_approval),
                    antes colapsado bajo el mismo rótulo genérico acá. */}
                {visiblePendingIsApproval ? 'Se requiere aprobación' : 'Respuesta pendiente'}
                {pendingGroups.length > 1 ? ` (${pendingGroups.length})` : ''}
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
            <View style={styles.pendingActions}>
              {visiblePending.actions.map((action) => (
                <TouchableOpacity
                  key={action.id}
                  style={[
                    styles.actionPill,
                    { backgroundColor: pillBackgroundForStyle(action.style) },
                    (actionBusy === action.id || action.submitted) && styles.actionPillDisabled,
                  ]}
                  disabled={state !== 'online' || actionBusy !== null || action.submitted}
                  onPress={() => handleAnswerAction(action)}
                >
                  {actionBusy === action.id ? (
                    <ActivityIndicator size="small" color={Colors.background} />
                  ) : action.submitted ? (
                    <Text style={styles.actionPillText}>Enviada…</Text>
                  ) : (
                    <Text style={styles.actionPillText}>{action.label}</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
            {denyAction ? (
              <Text style={styles.stickyHint}>
                Desliza ↑ para ver el detalle · ← → para denegar
              </Text>
            ) : (
              <Text style={styles.stickyHint}>Desliza ↑ para ver el detalle</Text>
            )}
          </Animated.View>
          </GestureDetector>
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
                    {/* Cuerpo completo y sin recortar: es lo único que
                        distingue esta vista de la tarjeta. Con `detail` y
                        numberOfLines={3} el botón de info mostraba el mismo
                        texto que ya se veía y no revelaba cwd ni expiración. */}
                    {(group.detailFull ?? group.detail) ? (
                      <Text style={styles.popoverRowDetail} selectable>
                        {group.detailFull ?? group.detail}
                      </Text>
                    ) : null}
                    <View style={styles.pendingActions}>
                      {group.actions.map((action) => (
                        <TouchableOpacity
                          key={action.id}
                          style={[
                            styles.actionPill,
                            { backgroundColor: pillBackgroundForStyle(action.style) },
                            (actionBusy === action.id || action.submitted) && styles.actionPillDisabled,
                          ]}
                          disabled={state !== 'online' || actionBusy !== null || action.submitted}
                          onPress={() => {
                            setShowPendingPopover(false);
                            handleAnswerAction(action);
                          }}
                        >
                          {actionBusy === action.id ? (
                            <ActivityIndicator size="small" color={Colors.background} />
                          ) : action.submitted ? (
                            <Text style={styles.actionPillText}>Enviada…</Text>
                          ) : (
                            <Text style={styles.actionPillText}>{action.label}</Text>
                          )}
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>

        {/* Swipe lateral en una burbuja abre esto: selectable dentro de la
            FlatList no era confiable (ver AGENTS.md), así que el texto se
            selecciona acá, en un TextInput fuera de la lista donde Android sí
            lo maneja bien. multiline + editable=false: de solo lectura, pero
            un TextInput sí soporta selección/copiado nativo sin pelear con
            el scroll de nada. */}
        <Modal
          visible={selectableText !== null}
          animationType="fade"
          transparent
          onRequestClose={() => setSelectableText(null)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setSelectableText(null)}>
            <View style={styles.popoverContent}>
              <View style={styles.popoverHeader}>
                <Text style={styles.popoverTitle}>Seleccionar texto</Text>
                <TouchableOpacity onPress={() => setSelectableText(null)}>
                  <Ionicons name="close" size={20} color={Colors.textDim} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.selectableTextScroll}>
                <TextInput
                  style={styles.selectableTextInput}
                  value={selectableText ?? ''}
                  // editable={false} deshabilita el focus del EditText nativo
                  // en Android, y sin focus no hay selección de texto — el
                  // mismo tipo de trampa que ya nos mordió con Text
                  // selectable. Se queda "editable" a nivel nativo (así el
                  // long-press abre los tiradores) pero onChangeText
                  // descarta cualquier intento de edición: de solo lectura
                  // para el usuario, sin serlo para el componente nativo.
                  onChangeText={() => {}}
                  multiline
                  showSoftInputOnFocus={false}
                />
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

        {/* Como en GTK: el consumo de contexto va pegado encima del input, no
            en el toolbar — es lo que miras mientras escribes. */}
        {contextFraction !== null && (
          <View style={styles.contextBar}>
            <View style={[styles.contextFill, {
              width: `${Math.round(contextFraction * 100)}%`,
              backgroundColor: contextBarColor,
            }]} />
          </View>
        )}

        {/* Antes la única señal de "estoy grabando" era el ícono del propio
            botón que el dedo está tapando mientras se mantiene presionado —
            invisible en la práctica. Esta barra vive arriba del input, fuera
            del área del dedo, y crece/actualiza mientras dura la grabación. */}
        {(voice.recordingState === 'holding' || voice.recordingState === 'locked'
          || voice.recordingState === 'uploading') && (
          <View style={styles.recordingBar}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingTime}>
              {formatDuration(voice.elapsedMs / 1000)}
            </Text>
            <Text style={styles.recordingHint}>
              {voice.recordingState === 'uploading'
                ? 'Enviando…'
                : 'Suelta para enviar'}
            </Text>
          </View>
        )}

        <View style={styles.inputBar}>
          <TouchableOpacity
            style={[styles.attachBtn, (state !== 'online' || attaching) && styles.sendBtnDisabled]}
            onPress={handleAttach}
            disabled={state !== 'online' || attaching}
          >
            {attaching ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : (
              <Ionicons name="attach" size={22} color={Colors.primary} />
            )}
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={handleInputChange}
            placeholder="Escribe un mensaje..."
            placeholderTextColor={Colors.textDim}
            multiline
            maxLength={2000}
            onSubmitEditing={handleSend}
            returnKeyType="send"
            editable={state === 'online'}
          />
          {input.trim() ? (
            <TouchableOpacity
              style={[styles.sendBtn, (!input.trim() || state !== 'online') && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!input.trim() || state !== 'online'}
            >
              <Ionicons name="send" size={20} color={Colors.background} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.sendBtn, state !== 'online' && styles.sendBtnDisabled]}
              onPressIn={handleVoicePressIn}
              onPressOut={handleVoicePressOut}
              disabled={state !== 'online'}
            >
              <Ionicons
                name={voice.recordingState === 'holding' || voice.recordingState === 'locked'
                  ? 'radio' : 'mic'}
                size={20}
                color={voice.recordingState === 'holding' || voice.recordingState === 'locked'
                  ? '#ff4444' : Colors.background}
              />
            </TouchableOpacity>
          )}
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
  // El maxWidth vive en el wrapper (hijo directo de messageRow), no en la
  // burbuja: sólo así el 82% se mide contra el ancho de la fila y no contra
  // el del wrapper ya encogido. Ver el comentario en MessageBubble.
  messageBubbleWrapper: { maxWidth: '82%' },
  // alignSelf flex-start: la burbuja se encoge a su contenido (un "ok" no
  // ocupa el 82% entero) pero puede crecer hasta el maxWidth del wrapper.
  bubble: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  bubbleLeft: {
    backgroundColor: Colors.assistantBubble,
    borderWidth: 1,
    borderColor: Colors.assistantBubbleBorder,
    borderBottomLeftRadius: 4,
  },
  bubbleRight: { backgroundColor: Colors.userBubble, borderBottomRightRadius: 4 },
  senderName: { fontSize: 12, fontWeight: '600', color: Colors.primary, marginBottom: 4 },
  messageBody: { gap: 6 },
  messageText: { fontSize: 15, color: Colors.text, lineHeight: 21 },
  messageTextMine: { color: Colors.userBubbleText },
  // overflow hidden: es el "viewport" del scroll manual (Gesture.Pan en
  // MarkdownTableView) — sin esto, arrastrar la tabla la desbordaría fuera
  // de la burbuja en vez de recortarse en su borde.
  markdownTableScroll: { alignSelf: 'flex-start', maxWidth: '100%', overflow: 'hidden' },
  markdownTable: {
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: 6,
    overflow: 'hidden',
  },
  markdownTableRow: { flexDirection: 'row' },
  markdownTableCell: {
    color: Colors.text,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  markdownTableHeader: {
    fontWeight: '700',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  codeBlock: {
    minWidth: 220,
    overflow: 'hidden',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    backgroundColor: 'rgba(0,0,0,0.16)',
  },
  codeHeader: {
    minHeight: 30,
    paddingLeft: 8,
    paddingRight: 4,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  codeLanguage: {
    flex: 1,
    color: Colors.textDim,
    fontSize: 12,
    fontWeight: '600',
  },
  codeCopyButton: {
    width: 30,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  codeText: {
    paddingHorizontal: 9,
    paddingVertical: 8,
    color: Colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 18,
  },
  timestamp: { fontSize: 11, color: Colors.textDim, marginTop: 4, alignSelf: 'flex-end' },
  bubbleFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  bubbleStreaming: { borderWidth: 1, borderColor: Colors.primary },
  toolOutputScroll: { maxHeight: 180 },
  sendFailedText: { fontSize: 12, color: Colors.error, marginTop: 4 },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  typingText: { fontSize: 12, color: Colors.textDim, fontStyle: 'italic' },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitleText: { fontSize: 17, fontWeight: '600', color: Colors.text, maxWidth: 200 },
  headerAvatar: { width: 28, height: 28, borderRadius: 14 },
  headerAvatarFallback: {
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timestampMine: { color: 'rgba(255,255,255,0.7)' },
  agentToolbar: {
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  statusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusSpacer: {
    flex: 1,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusActivity: {
    color: Colors.textDim,
    fontSize: 12,
    flexShrink: 1,
  },
  statusActivityPending: {
    color: Colors.warning,
    fontWeight: '700',
  },
  statusMetrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingBottom: 2,
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
  // Autorizar/denegar una acción del agente pesa distinto que una pregunta
  // cualquiera — el borde de acento es la única diferencia visual con
  // pendingCard, el ícono y el texto del título ya distinguen el resto.
  pendingCardApproval: {
    borderColor: Colors.warning,
  },
  // Asa visual: sin ella el gesto de arrastrar no se descubre.
  stickyGrabber: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.surfaceBorder,
    marginBottom: 2,
  },
  stickyHint: { color: Colors.textDim, fontSize: 11, textAlign: 'center' },
  pendingHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  pendingTitle: { color: Colors.warning, fontSize: 13, fontWeight: '700' },
  pendingTime: { color: Colors.textDim, fontSize: 12 },
  pendingDetail: { color: Colors.text, fontSize: 13, lineHeight: 18 },
  // Los botones envuelven a una segunda línea en vez de vivir en un
  // ScrollView horizontal: con 3 acciones (Allow Once / Allow Always / Deny)
  // el scroll dejaba "Deny" fuera de pantalla, invisible salvo que el usuario
  // adivinara que había que arrastrar.
  pendingActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingRight: 4 },
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
  attachmentImage: {
    width: 220,
    height: 160,
    borderRadius: 10,
    marginBottom: 6,
    backgroundColor: Colors.surface,
  },
  attachmentFile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: Colors.surface,
    marginBottom: 6,
  },
  attachmentFileName: { color: Colors.primary, fontSize: 13, flexShrink: 1 },
  modelBadgeText: {
    color: Colors.primary,
    fontSize: 11,
    fontWeight: '700',
    flexShrink: 1,
  },
  contextPercent: {
    fontSize: 11,
    fontWeight: '700',
  },
  contextBar: {
    height: 5,
    marginHorizontal: 12,
    marginBottom: 4,
    borderRadius: 3,
    backgroundColor: Colors.inputBackground,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    overflow: 'hidden',
  },
  contextFill: {
    height: '100%',
    backgroundColor: Colors.primary,
    borderRadius: 3,
    position: 'absolute',
    left: 0,
    top: 0,
  },
  connectionLabel: {
    color: Colors.textDim,
    fontSize: 11,
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
  agentControlsPanel: {
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 2,
    paddingBottom: 8,
  },
  bypassRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
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
  recordingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.surfaceBorder,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ff4444',
  },
  recordingTime: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  recordingHint: {
    color: Colors.textDim,
    fontSize: 13,
    marginLeft: 'auto',
  },
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
  attachBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  selectableTextScroll: {
    maxHeight: '100%',
  },
  selectableTextInput: {
    padding: 16,
    color: Colors.text,
    fontSize: 15,
    lineHeight: 21,
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
  audioBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  audioLabel: {
    color: Colors.primary,
    fontSize: 14,
  },
});
