import { memo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { AgentOrb } from '@/components/agent/AgentOrb';
import { Colors } from '@/constants/theme';
import { useAgentState, useRoom } from '@/xmpp/XmppContext';
import { displayName } from '@/xmpp/presence';
import { useConnectionState, useContact } from './stores';

/** Título del header: orbe del agente (o sala) + nombre. Se suscribe por su cuenta; la pantalla no re-renderiza. */
function ChatHeaderTitleImpl({ jid }: { jid: string }) {
  const room = useRoom(jid);
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
    </Pressable>
  );
}

export const ChatHeaderTitle = memo(ChatHeaderTitleImpl);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  title: { fontSize: 17, fontWeight: '600', color: Colors.text, maxWidth: 220 },
});
