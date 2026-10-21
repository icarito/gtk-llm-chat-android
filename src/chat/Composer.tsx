import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Alert, Animated, Linking, Platform, Pressable, StyleSheet, Text, Vibration, View, type TextInputKeyPressEventData } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  generateId,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type AttachmentAdapter,
  type QuoteInfo,
} from '@assistant-ui/react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { Colors } from '@/constants/theme';
import { XmppService } from '@/xmpp/XmppService';
import { RECORDING_MIME } from '@/xmpp/audioUtils';
import { chooseAttachment, type Picked } from './attachPicker';
import { SuggestionBar } from './SuggestionBar';
import { toThreadMessageLike } from './messageBridge';
import type { ChatMessage } from './toIMessage';

export type ReplyTo = { id: string; jid: string; quotedText: string };

export type MentionApi = {
  /** Completa la mención actual (token `@…`) con `name` y reinicia el menú. */
  complete: (name: string) => void;
  /** Cantidad de sugerencias abiertas (0 = no hay menú). */
  count: number;
  /** Primera sugerencia (la que completa Tab). */
  first?: string;
};

type Ctx = {
  jid: string;
  type: 'chat' | 'groupchat';
  online: boolean;
  /** Resuelve la cita (id del mensaje + texto) a los datos de XEP-0461. */
  resolveReply: (q: QuoteInfo) => ReplyTo | undefined;
  notify: (message: string) => void;
  /** Reinicia el estado XEP-0085 al enviar. */
  composingAt: MutableRefObject<number>;
  /** Envía el borrador actual del composer (texto + adjuntos + cita) por XMPP. */
  sendComposer: () => Promise<void>;
  /** Inserta `@name ` al final del borrador (tap en un nombre / mención). */
  insertMention: (name: string) => void;
  /** API del menú de menciones (para completar con Tab desde el input). */
  mentionRef: MutableRefObject<MentionApi>;
};
const ComposerCtx = createContext<Ctx | null>(null);
export const useCtx = () => {
  const c = useContext(ComposerCtx);
  if (!c) throw new Error('Composer fuera de ComposerProvider');
  return c;
};

// ── adjuntos: el selector devuelve un Picked; el adaptador lo lleva por aui sin copiarlo ──
type PickedFile = Picked & { type: string };
const pickedFile = (p: Picked) => ({ uri: p.uri, name: p.name, type: p.mime }) as PickedFile as unknown as File;

const attachmentAdapter: AttachmentAdapter = {
  accept: '*',
  async add({ file }) {
    const f = file as unknown as PickedFile;
    return {
      id: generateId(),
      type: f.type.startsWith('image/') ? 'image' : 'file',
      name: f.name,
      contentType: f.type,
      file,
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  },
  async send(a) {
    const f = a.file as unknown as PickedFile;
    return {
      ...a,
      status: { type: 'complete' },
      content: [{ type: 'file', data: f.uri, mimeType: f.type, filename: f.name }],
    };
  },
  async remove() {},
};

async function upload(c: { jid: string; type: 'chat' | 'groupchat' }, uri: string, name: string, mime: string) {
  const blob = await (await fetch(uri)).blob();
  await XmppService.sendFile(c.jid, blob, name, mime, c.type);
}

/** Expone el runtime aui y el envío manual a las vistas del chat. */
export function ComposerProvider({ children, quoteRef, messages, hasEarlier, onLoadEarlier, isLoading, ...ctx }: Omit<Ctx, 'composingAt' | 'sendComposer' | 'insertMention' | 'mentionRef'> & {
  quoteRef: MutableRefObject<((q: QuoteInfo) => void) | null>;
  messages: readonly ChatMessage[];
  hasEarlier?: boolean;
  onLoadEarlier?: () => Promise<void>;
  isLoading?: boolean;
  children: ReactNode;
}) {
  const composingAt = useRef(0);
  const sendingRef = useRef(false);
  const mentionRef = useRef<MentionApi>({ complete: () => {}, count: 0 });
  const auiRef = useRef<ReturnType<typeof useAui> | null>(null);

  const insertMention = useCallback((name: string) => {
    const aui = auiRef.current;
    if (!aui || !name) return;
    const st = aui.composer.getState();
    aui.composer.setText(`${st.text.replace(/\s+$/, '')} @${name} `);
  }, []);

  const base = useMemo<Omit<Ctx, 'sendComposer' | 'insertMention' | 'mentionRef'>>(
    () => ({ ...ctx, composingAt }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.jid, ctx.type, ctx.online, ctx.resolveReply, ctx.notify],
  );

  const onNew = useCallback(async (m: AppendMessage) => {
    base.composingAt.current = 0;
    if (XmppService.getState() !== 'online') { base.notify('Sin conexión — no se pudo enviar'); return; }
    const text = m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('').trim();
    const quote = (m.metadata.custom as { quote?: QuoteInfo }).quote;
    for (const a of m.attachments ?? []) {
      for (const p of a.content) {
        if (p.type !== 'file') continue;
        try { await upload(base, p.data, p.filename ?? a.name, p.mimeType); }
        catch (e) { Alert.alert('No se pudo enviar el archivo', e instanceof Error ? e.message : String(e)); }
      }
    }
    if (!text) return;
    try {
      const replyTo = quote ? base.resolveReply(quote) : undefined;
      await XmppService.sendMessage(base.jid, text, base.type, replyTo ? { replyTo } : {});
    } catch (e) {
      base.notify(e instanceof Error ? e.message : String(e));
    }
  }, [base]);

  // Envío manual: evita el append optimista del runtime (que duplicaría el
  // mensaje con el "pending" que ya aporta el store XMPP). Lee el estado del
  // composer y repite la lógica de onNew.
  const sendComposer = useCallback(async () => {
    const aui = auiRef.current;
    if (!aui) return;
    const st = aui.composer.getState();
    const text = st.text.trim();
    const quote = st.quote;
    const attachments = st.attachments;
    if (!text && attachments.length === 0) return;
    if (XmppService.getState() !== 'online') { base.notify('Sin conexión — no se pudo enviar'); return; }
    if (sendingRef.current) return;
    sendingRef.current = true;
    // Limpiar el composer de INMEDIATO (optimista): el texto desaparece ya y no
    // hay sensación de poder reenviar el mismo mensaje.
    await aui.composer.reset();
    // El envío (adjuntos + stanza) corre en background: la UI nunca espera por
    // red. Si algo falla, el mensaje queda como "failed" en el store y se puede
    // reintentar desde la burbuja.
    void (async () => {
      try {
        for (const a of attachments) {
        const file = (a as unknown as { file?: PickedFile }).file;
        const uri = file?.uri;
        if (!uri) continue;
        const name = file?.name ?? a.name ?? 'adjunto';
        const mime = file?.mime ?? a.contentType ?? 'application/octet-stream';
        try { await upload(base, uri, name, mime); }
        catch (e) { Alert.alert('No se pudo enviar el archivo', e instanceof Error ? e.message : String(e)); }
      }
        if (!text) return;
        try {
          const replyTo = quote ? base.resolveReply(quote) : undefined;
          await XmppService.sendMessage(base.jid, text, base.type, replyTo ? { replyTo } : {});
        } catch (e) {
          base.notify(e instanceof Error ? e.message : String(e));
        }
      } finally {
        sendingRef.current = false;
      }
    })();
  }, [base]);

  const value = useMemo<Ctx>(
    () => ({ ...base, sendComposer, insertMention, mentionRef }),
    [base, sendComposer, insertMention, mentionRef],
  );

  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    convertMessage: toThreadMessageLike,
    isDisabled: !ctx.online,
    hasEarlier,
    onLoadEarlier,
    isLoading,
    onNew,
    adapters: { attachments: attachmentAdapter },
  });
  return (
      <AssistantRuntimeProvider runtime={runtime}>
      <ComposerCtx.Provider value={value}>
        <AuiBridge auiRef={auiRef} />
        <QuoteBridge quoteRef={quoteRef} />
        <DraftPersistence jid={ctx.jid} />
        {children}
      </ComposerCtx.Provider>
    </AssistantRuntimeProvider>
  );
}

/** Cenamos la referencia al runtime aui para sendComposer (no se puede llamar useAui aquí). */
function AuiBridge({ auiRef }: { auiRef: MutableRefObject<ReturnType<typeof useAui> | null> }) {
  const aui = useAui();
  useEffect(() => {
    auiRef.current = aui;
    return () => { auiRef.current = null; };
  }, [aui, auiRef]);
  return null;
}

/** Expone setQuote a ChatPane (menú "Responder" / deslizar) sin suscribirse al texto. */
function QuoteBridge({ quoteRef }: { quoteRef: MutableRefObject<((q: QuoteInfo) => void) | null> }) {
  const aui = useAui();
  useEffect(() => {
    quoteRef.current = (q) => aui.composer.setQuote(q);
    return () => { quoteRef.current = null; };
  }, [aui, quoteRef]);
  return null;
}

const DRAFT_KEY = (jid: string) => `composer.draft:${jid}`;

/** Borrador por sala: se guarda (debounced) y se restaura al reentrar, para
 *  retomar una idea aunque se cierre el cliente. Se borra al llegar a vacío. */
function DraftPersistence({ jid }: { jid: string }) {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    AsyncStorage.getItem(DRAFT_KEY(jid)).then((saved) => {
      if (saved && saved.trim() && aui.composer.getState().text === '') {
        aui.composer.setText(saved);
      }
    }).catch(() => {});
  }, [jid, aui]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (text.trim()) void AsyncStorage.setItem(DRAFT_KEY(jid), text).catch(() => {});
      else void AsyncStorage.removeItem(DRAFT_KEY(jid)).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [text, jid]);
  return null;
}

/** XEP-0085 saliente: composing al teclear (máx. cada 8s), paused al vaciar. */
function ChatStateReporter() {
  const { jid, composingAt } = useCtx();
  const text = useAuiState((s) => s.composer.text);
  useEffect(() => {
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
  }, [text, jid, composingAt]);
  return null;
}

// ── nota de voz: mantener pulsado; soltar fuera del botón o un toque corto cancela ──
const MIN_VOICE_MS = 600;
/** Desplazamiento a la izquierda (px) a partir del cual soltar cancela la nota de voz. */
const CANCEL_DX = 90;

type VoicePhase = 'idle' | 'recording' | 'cancel' | 'sending';
type Voice = {
  phase: VoicePhase;
  durationMs: number;
  /** Nivel de entrada 0..1 (metering). */
  level: number;
  grant: () => void;
  move: (dx: number) => void;
  release: () => void;
  abort: () => void;
};
const VoiceCtx = createContext<Voice | null>(null);
const useVoice = () => {
  const v = useContext(VoiceCtx);
  if (!v) throw new Error('useVoice fuera de VoiceProvider');
  return v;
};

/**
 * Estado de la nota de voz, compartido por el botón y la barra de grabación.
 * El feedback es inmediato al tocar (no espera permiso/prepare); soltar envía,
 * deslizar a la izquierda y soltar cancela, un toque corto avisa cómo usarlo.
 */
function VoiceProvider({ children }: { children: ReactNode }) {
  const c = useCtx();
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const state = useAudioRecorderState(recorder, 100);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const phaseRef = useRef<VoicePhase>('idle');
  const starting = useRef<Promise<boolean> | null>(null);
  const startedAt = useRef(0);
  const set = useCallback((p: VoicePhase) => { phaseRef.current = p; setPhase(p); }, []);

  const begin = useCallback(async () => {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permiso de micrófono denegado', 'Actívalo en los ajustes del sistema para grabar notas de voz.', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Ajustes', onPress: () => { void Linking.openSettings(); } },
      ]);
      return false;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    startedAt.current = Date.now();
    return true;
  }, [recorder]);

  const end = useCallback(async (send: boolean) => {
    const ok = await starting.current?.catch(() => false);
    starting.current = null;
    if (!ok) { set('idle'); return; }
    const long = Date.now() - startedAt.current >= MIN_VOICE_MS;
    if (send && !long) c.notify('Mantén presionado para grabar');
    const deliver = send && long;
    set(deliver ? 'sending' : 'idle');
    try {
      await recorder.stop();
      // Recording deja iOS en PlayAndRecord (reproducción por el auricular): se restablece.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      if (deliver && recorder.uri) {
        if (XmppService.getState() !== 'online') c.notify('Sin conexión — no se pudo enviar');
        else await upload(c, recorder.uri, `voice_${Date.now()}.m4a`, RECORDING_MIME);
      }
    } catch (e) {
      c.notify(e instanceof Error ? e.message : String(e));
    } finally {
      set('idle');
    }
  }, [recorder, c, set]);

  const voice = useMemo<Voice>(() => ({
    phase,
    durationMs: phase === 'recording' || phase === 'cancel' ? state.durationMillis ?? 0 : 0,
    level: typeof state.metering === 'number' ? Math.max(0, Math.min(1, (state.metering + 60) / 60)) : 0,
    grant: () => {
      if (phaseRef.current !== 'idle') return;
      set('recording');
      Vibration.vibrate(15);
      starting.current = begin().catch((e) => { c.notify(e instanceof Error ? e.message : String(e)); return false; });
    },
    move: (dx) => {
      const p = phaseRef.current;
      if (p === 'recording' && dx < -CANCEL_DX) { set('cancel'); Vibration.vibrate(10); }
      else if (p === 'cancel' && dx >= -CANCEL_DX) set('recording');
    },
    release: () => { void end(phaseRef.current === 'recording'); },
    abort: () => { void end(false); },
  }), [phase, state.durationMillis, state.metering, begin, end, set, c]);

  return <VoiceCtx.Provider value={voice}>{children}</VoiceCtx.Provider>;
}

const fmtDuration = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Ocupa el lugar del input mientras se graba: punto que late, tiempo, nivel y cómo cancelar. */
function RecordingBar() {
  const { phase, durationMs, level } = useVoice();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.25, duration: 500, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 500, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  if (phase === 'sending') {
    return (
      <View style={styles.recBar}>
        <ActivityIndicator size="small" color={Colors.primary} />
        <Text style={styles.recHint}>Enviando nota de voz…</Text>
      </View>
    );
  }
  const cancel = phase === 'cancel';
  return (
    <View style={styles.recBar} accessibilityLiveRegion="polite">
      <Animated.View style={[styles.recDot, { opacity: pulse }]} />
      <Text style={styles.recTime}>{fmtDuration(durationMs)}</Text>
      <View style={styles.levelTrack}>
        <View style={[styles.levelFill, { width: `${Math.round(8 + level * 92)}%` }]} />
      </View>
      <Text style={[styles.recHint, cancel && styles.recCancel]} numberOfLines={1}>
        {cancel ? 'Suelta para cancelar' : '‹ Desliza para cancelar'}
      </Text>
    </View>
  );
}

function MicButton() {
  const c = useCtx();
  const v = useVoice();
  const startX = useRef(0);
  const active = v.phase === 'recording' || v.phase === 'cancel';
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel="Mantén presionado para grabar una nota de voz"
      onStartShouldSetResponder={() => c.online && v.phase === 'idle'}
      // El gesto es nuestro hasta soltar: que la lista no lo robe al deslizar.
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => { startX.current = e.nativeEvent.pageX; v.grant(); }}
      onResponderMove={(e) => v.move(e.nativeEvent.pageX - startX.current)}
      onResponderRelease={() => v.release()}
      onResponderTerminate={() => v.abort()}
      style={[styles.round, active && styles.recording, v.phase === 'cancel' && styles.recordingCancel, !c.online && styles.disabled]}
    >
      {v.phase === 'sending'
        ? <ActivityIndicator size="small" color={Colors.primary} />
        : <Ionicons name={v.phase === 'cancel' ? 'trash' : 'mic'} size={active ? 24 : 20} color={Colors.text} />}
    </View>
  );
}

function AddButton() {
  const aui = useAui();
  const busy = useRef(false);
  const onPress = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const asset = await chooseAttachment();
      if (asset) await aui.composer.addAttachment(pickedFile(asset));
    } catch (e) {
      Alert.alert('No se pudo adjuntar', e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, [aui]);
  return (
    <ComposerPrimitive.AddAttachment onPress={onPress} accessibilityLabel="Adjuntar" style={styles.round}>
      <Ionicons name="add" size={24} color={Colors.primary} />
    </ComposerPrimitive.AddAttachment>
  );
}

function InputOrRecording() {
  const { phase } = useVoice();
  if (phase !== 'idle') return <RecordingBar />;
  return (
    <>
      <AddButton />
      <Input />
    </>
  );
}

function SendOrMic() {
  const empty = useAuiState((s) => s.composer.isEmpty);
  const { sendComposer } = useCtx();
  return empty ? <MicButton /> : (
    <Pressable
      style={[styles.round, styles.send]}
      onPress={() => { void sendComposer(); }}
      accessibilityRole="button"
      accessibilityLabel="Enviar"
    >
      <Ionicons name="arrow-up" size={20} color={Colors.background} />
    </Pressable>
  );
}

function Input() {
  const { online, sendComposer, mentionRef } = useCtx();
  return (
    <ComposerPrimitive.Input
      submitMode="none"
      multiline
      editable={online}
      testID="composer-input"
      onKeyPress={(e) => {
        if (Platform.OS !== 'web') return;
        const ne = e.nativeEvent as TextInputKeyPressEventData & { shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
        if (ne.key === 'Tab') {
          const m = mentionRef.current;
          if (m.count > 0 && m.first) {
            (e as unknown as { preventDefault?: () => void }).preventDefault?.();
            m.complete(m.first);
          }
          return;
        }
        if (ne.key === 'Enter' && !ne.shiftKey && !ne.isComposing && ne.keyCode !== 229) {
          (e as unknown as { preventDefault?: () => void }).preventDefault?.();
          void sendComposer();
        }
      }}
      placeholder={online ? 'Escribe un mensaje…' : 'Sin conexión'}
      placeholderTextColor={Colors.textDim}
      style={styles.input}
    />
  );
}

/** Autocompletado de menciones `@` (sólo desktop/web): muestra sugerencias de
 *  ocupantes/contactos y las completa con Enter/Tab o tap. En mobile no se
 *  pinta para no robar foco ni teclado. */
function MentionBar() {
  const { jid, mentionRef } = useCtx();
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const candidates = useMemo(() => {
    const room = typeof XmppService.rooms?.get === 'function' ? XmppService.rooms.get(jid) : undefined;
    if (room) return Object.keys(room.occupants).filter((n) => n && n !== room.nick);
    const local = jid.split('@')[0];
    return local ? [local] : [];
  }, [jid]);
  const prefix = (text.match(/(?:^|\s)@([^\s@]*)$/)?.[1] ?? '').toLowerCase();
  const suggestions = useMemo(() => {
    if (!text.match(/(?:^|\s)@[^\s@]*$/)) return [];
    return candidates.filter((n) => n.toLowerCase().startsWith(prefix)).slice(0, 6);
  }, [candidates, prefix, text]);
  useEffect(() => {
    mentionRef.current = {
      complete: (name) => {
        const idx = text.lastIndexOf('@');
        const before = idx >= 0 ? text.slice(0, idx) : text.replace(/\s+$/, '');
        aui.composer.setText(`${before}@${name} `);
      },
      count: suggestions.length,
      first: suggestions[0],
    };
  }, [text, suggestions, aui, mentionRef]);
  if (Platform.OS !== 'web' || suggestions.length === 0) return null;
  return (
    <View style={styles.mentionBar}>
      {suggestions.map((n) => (
        <Pressable key={n} style={styles.mentionChip} onPress={() => mentionRef.current.complete(n)} accessibilityRole="button">
          <Text style={styles.mentionChipText}>@{n}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Toolbar de <Chat>: referencia estable (constante de módulo), todo su estado va por aui. */
export function ComposerToolbar() {
  const { jid } = useCtx();
  // App edge-to-edge: sin este padding el input queda debajo de la barra de navegación
  // de Android (el InputToolbar de la lib lo hacía; el nuestro lo había perdido).
  const { bottom } = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingBottom: bottom }]}>
      <ChatStateReporter />
      <SuggestionBar jid={jid} />
      <MentionBar />
      <ComposerPrimitive.Quote style={styles.quote}>
        <ComposerPrimitive.QuoteText numberOfLines={2} style={styles.quoteText} />
        <ComposerPrimitive.QuoteDismiss accessibilityLabel="Cancelar respuesta">
          <Ionicons name="close" size={18} color={Colors.textDim} />
        </ComposerPrimitive.QuoteDismiss>
      </ComposerPrimitive.Quote>
      <ComposerPrimitive.Attachments>
        {() => (
          <AttachmentPrimitive.Root style={styles.chip}>
            <Ionicons name="document-outline" size={16} color={Colors.primary} />
            <AttachmentPrimitive.Name numberOfLines={1} style={styles.chipText} />
            <AttachmentPrimitive.Remove accessibilityLabel="Quitar adjunto">
              <Ionicons name="close-circle" size={18} color={Colors.textDim} />
            </AttachmentPrimitive.Remove>
          </AttachmentPrimitive.Root>
        )}
      </ComposerPrimitive.Attachments>
      <VoiceProvider>
        <ComposerPrimitive.Root style={styles.root}>
          <InputOrRecording />
          <SendOrMic />
        </ComposerPrimitive.Root>
      </VoiceProvider>
    </View>
  );
}
export const renderComposerToolbar = () => <ComposerToolbar />;

const styles = StyleSheet.create({
  wrap: { backgroundColor: Colors.surface },
  root: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, padding: 8, backgroundColor: Colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.surfaceBorder },
  input: { flex: 1, minHeight: 40, maxHeight: 120, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder, color: Colors.text, fontSize: 16 },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  send: { backgroundColor: Colors.primary },
  mentionBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 8, paddingTop: 4 },
  mentionChip: { backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  mentionChipText: { color: Colors.primary, fontSize: 13, fontWeight: '600' },
  recording: { backgroundColor: Colors.error, transform: [{ scale: 1.25 }] },
  recordingCancel: { backgroundColor: Colors.surfaceBorder },
  disabled: { opacity: 0.4 },
  recBar: { flex: 1, minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.error },
  recTime: { color: Colors.text, fontSize: 16, fontVariant: ['tabular-nums'], minWidth: 40 },
  levelTrack: { width: 48, height: 6, borderRadius: 3, backgroundColor: Colors.surfaceBorder, overflow: 'hidden' },
  levelFill: { height: 6, backgroundColor: Colors.error },
  recHint: { flex: 1, color: Colors.textDim, fontSize: 14, textAlign: 'right' },
  recCancel: { color: Colors.error, fontWeight: '600' },
  quote: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: Colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.surfaceBorder },
  quoteText: { flex: 1, color: Colors.textDim, fontSize: 13 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 8, marginTop: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder, alignSelf: 'flex-start' },
  chipText: { color: Colors.text, fontSize: 13, maxWidth: 220 },
});
