import { memo, useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { ApprovalForMessage } from './ApprovalForMessage';
import { usePeerTyping, usePendingActions } from './stores';

/** XEP-0085 "escribiendo…" mero marcado, sin hook: se monta como ListFooter de
 *  la lista para no tapar el último mensaje (antes era un strip sobre el composer). */
export const TypingIndicator = memo(function TypingIndicator() {
  return (
    <View style={styles.typing}>
      <ActivityIndicator size={12} color={Colors.textDim} />
      <Text style={styles.typingText}>escribiendo…</Text>
    </View>
  );
});

/** XEP-0085 "escribiendo…". Footer propio (no `isTyping`): esa prop viaja a todas las filas y las re-renderizaría. */
export const TypingFooter = memo(function TypingFooter({ jid }: { jid: string }) {
  const typing = usePeerTyping(jid);
  if (!typing) return null;
  return <TypingIndicator />;
});

/** Pie fijo: sólo existe mientras haya acciones pendientes en esta conversación. */
export const PendingFooter = memo(function PendingFooter({ jid }: { jid: string }) {
  const all = usePendingActions();
  const groups = useMemo(() => {
    const newest = new Map<string, string>();
    for (const a of all) {
      if (a.conversationJid !== jid || a.submitted) continue;
      const prev = newest.get(a.messageId);
      if (!prev || a.timestamp > prev) newest.set(a.messageId, a.timestamp);
    }
    return [...newest.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1));
  }, [all, jid]);
  if (groups.length === 0) return null;
  return (
    <View style={styles.pending}>
      {groups.length > 1 ? <Text style={styles.count}>{groups.length} pendientes</Text> : null}
      <ApprovalForMessage jid={jid} messageId={groups[0]![0]} />
    </View>
  );
});

export const StatusBanner = memo(function StatusBanner({ text, busy }: { text: string; busy?: boolean }) {
  return (
    <View style={styles.banner}>
      {busy ? <ActivityIndicator size="small" color={Colors.primary} /> : null}
      <Text style={styles.bannerText}>{text}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  typing: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 6, paddingBottom: 10 },
  typingText: { fontSize: 12, color: Colors.textDim, fontStyle: 'italic' },
  pending: { padding: 8, gap: 4, backgroundColor: Colors.background },
  count: { color: Colors.warning, fontSize: 12, fontWeight: '700', paddingHorizontal: 4 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 4,
    backgroundColor: Colors.surface,
  },
  bannerText: { color: Colors.textDim, fontSize: 12 },
});
