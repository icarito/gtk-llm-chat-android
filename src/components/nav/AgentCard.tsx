import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { useAgentState } from '@/xmpp/XmppContext';
import { useContact } from '@/chat/stores';
import { useAgentCaps } from '@/xmpp/caps';
import { displayName, presenceColor, presenceLabel } from '@/xmpp/presence';

/** Tarjeta compacta de agente: presencia + actividad/estado desde agentState. */
export const AgentCard = memo(function AgentCard({ jid, onPress }: { jid: string; onPress: (jid: string) => void }) {
  const contact = useContact(jid);
  const state = useAgentState(jid);
  const caps = useAgentCaps(jid);
  if (!caps.caps?.isAgent) return null;
  const activity = state?.activity || state?.availability || contact?.status || presenceLabel(contact?.presence ?? 'offline');
  const detail = [state?.model, state?.tool && `🔧 ${state.tool}`, state?.pendingCount ? `${state.pendingCount} en cola` : '']
    .filter(Boolean).join(' · ');
  const approvals = state ? [...state.approvals.values()].filter((a) => a.state === 'pending' && !a.decision).length : 0;
  return (
    <Pressable style={styles.card} onPress={() => onPress(jid)} accessibilityRole="button">
      <View style={[styles.dot, { backgroundColor: presenceColor(contact?.presence ?? 'offline') }]} />
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{displayName(jid, contact?.name)}</Text>
        <Text style={styles.activity} numberOfLines={1}>{activity}</Text>
        {!!detail && <Text style={styles.detail} numberOfLines={1}>{detail}</Text>}
      </View>
      {approvals > 0 && <Text style={styles.badge}>{approvals} aprobación{approvals > 1 ? 'es' : ''}</Text>}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 12, marginTop: 8, padding: 12, borderRadius: 10, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder },
  dot: { width: 10, height: 10, borderRadius: 5 },
  info: { flex: 1 },
  name: { color: Colors.text, fontSize: 16, fontWeight: '600' },
  activity: { color: Colors.secondary, fontSize: 13, marginTop: 2 },
  detail: { color: Colors.textDim, fontSize: 12, marginTop: 2 },
  badge: { color: Colors.warning, fontSize: 12, fontWeight: '700' },
});
