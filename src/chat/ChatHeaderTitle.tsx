import { memo } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AgentOrb } from '@/components/agent/AgentOrb';
import { Colors } from '@/constants/theme';
import { useAgentState, useRoom, useRoomOmemoLabel } from '@/xmpp/XmppContext';
import { leaveRoom } from '@/xmpp/rooms';
import { displayName } from '@/xmpp/presence';
import { startCall } from '@/xmpp/jingle/manager';
import { useConnectionState, useContact } from './stores';

/** Título del header: orbe del agente (o sala) + nombre. Se suscribe por su cuenta; la pantalla no re-renderiza. */
function ChatHeaderTitleImpl({ jid }: { jid: string }) {
  const room = useRoom(jid);
  const omemoLabel = useRoomOmemoLabel(jid);
  const contact = useContact(jid);
  const agent = useAgentState(jid);
  const online = useConnectionState() === 'online';
  const pct = agent?.telemetry?.context.used !== undefined && agent.telemetry.context.max
    ? Math.min(Math.round((agent.telemetry.context.used / agent.telemetry.context.max) * 100), 100)
    : undefined;
  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push({ pathname: room ? '/room/[jid]' : '/encryption/[jid]', params: { jid: encodeURIComponent(jid) } } as never)}
      accessibilityLabel={room ? 'Participantes' : 'Cifrado'}
    >
      {room ? null : (
        <AgentOrb
          size={14}
          activity={agent?.activity}
          tool={agent?.tool}
          hasTelemetry={Boolean(agent?.telemetry)}
          connected={online && contact?.presence !== 'offline'}
          contextPct={pct}
        />
      )}
      <Text style={styles.title} numberOfLines={1}>
        {room ? room.name || displayName(jid) : displayName(jid, contact?.name)}
      </Text>
      {room && omemoLabel ? <Text style={styles.chip} numberOfLines={1}>{omemoLabel}</Text> : null}
      {room && (room.state === 'joined' || room.state === 'joining') ? (
        <Pressable
          onPress={(e) => {
            e.stopPropagation();
            Alert.alert('Salir de la sala', '¿Salir de esta sala?', [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Salir', style: 'destructive', onPress: () => { void leaveRoom(jid).catch(() => {}); router.back(); } },
            ]);
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Salir de la sala"
          style={styles.callBtn}
        >
          <Ionicons name="exit-outline" size={18} color={Colors.error} />
        </Pressable>
      ) : null}
      {!room && online && Platform.OS !== 'web' ? (
        <Pressable
          onPress={(e) => { e.stopPropagation(); void startCall(jid).catch((err) => Alert.alert('Llamada', err instanceof Error ? err.message : String(err))); }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Iniciar llamada de audio"
          style={styles.callBtn}
        >
          <Ionicons name="call" size={18} color={Colors.primary} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

export const ChatHeaderTitle = memo(ChatHeaderTitleImpl);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chip: { fontSize: 11, color: Colors.muted },
  callBtn: { padding: 2 },
  title: { fontSize: 17, fontWeight: '600', color: Colors.text, maxWidth: 220 },
});
