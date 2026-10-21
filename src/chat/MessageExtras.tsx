import { memo, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/theme';
import { openExternalUrl } from '@/platform/openExternalUrl';
import { isEncrypted } from '@/xmpp/encryption';
import { fileNameFromUrl } from './attachments';
import { ApprovalForMessage } from './ApprovalForMessage';
import type { ChatMessage } from './toIMessage';

/** Ventana tras la última corrección XEP-0308 en la que la burbuja se considera "en streaming". */
const STREAMING_WINDOW_MS = 6000;

/**
 * Spinner "en curso" con su PROPIO timeout: se apaga solo a los 6s sin tocar
 * la lista ni el mensaje (nada a nivel de pantalla hace tick).
 */
function StreamingSpinner({ correctedAtMs }: { correctedAtMs: number }) {
  const [live, setLive] = useState(() => Date.now() - correctedAtMs < STREAMING_WINDOW_MS);
  useEffect(() => {
    const left = STREAMING_WINDOW_MS - (Date.now() - correctedAtMs);
    setLive(left > 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setLive(false), left);
    return () => clearTimeout(timer);
  }, [correctedAtMs]);
  return live ? <ActivityIndicator size={12} color={Colors.primary} /> : null;
}

interface Props {
  jid: string;
  message: ChatMessage;
  onRetry: (id: string) => void;
}

function MessageExtrasImpl({ jid, message, onRetry }: Props) {
  const { meta } = message;
  return (
    <View style={styles.wrap}>
      {meta.fileUrl ? (
        <TouchableOpacity style={styles.file} onPress={() => { void openExternalUrl(meta.fileUrl!); }}>
          <Ionicons name="document-outline" size={18} color={Colors.primary} />
          <Text style={styles.fileName} numberOfLines={1}>{fileNameFromUrl(meta.fileUrl)}</Text>
        </TouchableOpacity>
      ) : null}
      {meta.actionable ? (
        <ApprovalForMessage jid={jid} messageId={String(message._id)} stanzaId={meta.stanzaId} />
      ) : null}
      {(meta.correctedAtMs !== undefined || meta.encryption) ? (
        <View style={styles.badges}>
          {meta.correctedAtMs !== undefined ? <StreamingSpinner correctedAtMs={meta.correctedAtMs} /> : null}
          {isEncrypted(meta.encryption) ? (
            <Ionicons name="lock-closed" size={11} color={Colors.success} accessibilityLabel="Mensaje cifrado con OMEMO" />
          ) : null}
          {meta.encryption === 'undecryptable' ? (
            <Ionicons name="warning" size={12} color={Colors.warning} accessibilityLabel="Mensaje cifrado que no se pudo descifrar" />
          ) : null}
        </View>
      ) : null}
      {meta.mine && meta.sendState === 'failed' ? (
        <TouchableOpacity onPress={() => onRetry(String(message._id))}>
          <Text style={styles.failed}>⚠ No enviado — tocar para reintentar</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// Los extras sólo dependen del mensaje (referencia estable por versión) y del jid.
export const MessageExtras = memo(MessageExtrasImpl, (a, b) => a.message === b.message && a.jid === b.jid);

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: Colors.surface,
  },
  fileName: { color: Colors.primary, fontSize: 13, flexShrink: 1 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'flex-end' },
  failed: { fontSize: 12, color: Colors.error },
});
