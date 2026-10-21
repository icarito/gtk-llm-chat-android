import { memo, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/theme';
import { AvatarWithPresence } from '@/chat/Avatar';
import { useContact } from '@/chat/stores';
import { useRoom } from '@/xmpp/XmppContext';
import { useAgentState } from '@/xmpp/XmppContext';
import { groupOccupants, type OccupantGroup } from '@/xmpp/xep/occupants';
import { roleWord } from '@/components/nav/rosterLogic';
import { presenceLabel } from '@/xmpp/presence';

function PresenceAvatar({ jid, name, size }: { jid: string; name?: string; size: number }) {
  const contact = useContact(jid);
  return (
    <AvatarWithPresence
      jid={jid}
      name={name ?? contact?.name}
      size={size}
      presence={contact?.presence ?? 'offline'}
    />
  );
}

function AgentRow({ group }: { group: OccupantGroup }) {
  const rowJid = group.key.startsWith('nick:') ? group.nicks[0] : group.key;
  const agent = useAgentState(rowJid);
  const contact = useContact(rowJid);
  const t = agent?.telemetry;
  const used = t?.context.used;
  const max = t?.context.max;
  const pct = used !== undefined && max ? Math.min(Math.round((used / max) * 100), 100) : undefined;
  const activity = agent?.activity ?? agent?.availability ?? presenceLabel(contact?.presence ?? 'offline');
  return (
    <View style={styles.row}>
      <PresenceAvatar jid={rowJid} name={contact?.name} size={34} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>{group.nicks.join(', ')}</Text>
          <Text style={styles.role} numberOfLines={1}>{roleWord(group.role, group.affiliation)}</Text>
        </View>
        <Text style={styles.activity} numberOfLines={1}>{activity}</Text>
        {pct !== undefined ? (
          <View style={styles.bar}><View style={[styles.barFill, { width: `${pct}%` }]} /></View>
        ) : null}
      </View>
    </View>
  );
}

function PersonRow({ group }: { group: OccupantGroup }) {
  const realJid = group.key.startsWith('nick:') ? undefined : group.key;
  return (
    <View style={styles.row}>
      <PresenceAvatar jid={realJid ?? group.nicks[0]} name={group.nicks[0]} size={34} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>{group.nicks.join(', ')}</Text>
          <Text style={styles.role} numberOfLines={1}>{roleWord(group.role, group.affiliation)}</Text>
        </View>
        {realJid ? <Text style={styles.dim} numberOfLines={1}>{realJid}</Text> : null}
      </View>
    </View>
  );
}

/** Franja de miembros de una MUC: colapsada como fila de avatares (con anillo de
 *  presencia = orbe); expandida lista a cada miembro, con stats para los agentes. */
export const RoomMembersBar = memo(function RoomMembersBar({ jid }: { jid: string }) {
  const [open, setOpen] = useState(false);
  const room = useRoom(jid);
  const groups = useMemo(() => {
    const { agents, people } = groupOccupants(Object.values(room?.occupants ?? {}));
    return { agents, people };
  }, [room?.occupants]);

  const members = useMemo(() => [...groups.people, ...groups.agents], [groups]);
  const all = [...groups.agents, ...groups.people];

  if (all.length === 0) return null;

  const strip = (size: number) => (
    <View style={styles.strip}>
      {all.map((g, i) => {
        const realJid = g.key.startsWith('nick:') ? undefined : g.key;
        return (
          <View key={g.key} style={i === 0 ? undefined : styles.stripItem}>
            <PresenceAvatar jid={realJid ?? g.nicks[0]} name={g.nicks[0]} size={size} />
            {g.isAgent ? <View style={styles.agentTag}><Ionicons name="hardware-chip" size={10} color="#0A0E14" /></View> : null}
          </View>
        );
      })}
    </View>
  );

  return (
    <View style={styles.container}>
      <Pressable style={styles.header} onPress={() => setOpen((v) => !v)} accessibilityRole="button">
        <View style={styles.headerLeft}>
          {strip(28)}
          <Text style={styles.count}>{members.length} miembro{members.length > 1 ? 's' : ''}</Text>
        </View>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textDim} />
      </Pressable>
      {open ? (
        <View style={styles.list}>
          {groups.people.map((g) => <PersonRow key={g.key} group={g} />)}
          {groups.agents.map((g) => <AgentRow key={g.key} group={g} />)}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { backgroundColor: Colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.surfaceBorder },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  strip: { flexDirection: 'row', alignItems: 'center' },
  stripItem: { marginLeft: -6 },
  agentTag: { position: 'absolute', right: -2, bottom: -2, backgroundColor: Colors.primary, borderRadius: 6, width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  count: { color: Colors.textDim, fontSize: 13 },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.surfaceBorder, paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 6 },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  name: { color: Colors.text, fontSize: 14, fontWeight: '600', flex: 1 },
  role: { color: Colors.textDim, fontSize: 11 },
  activity: { color: Colors.secondary, fontSize: 12 },
  dim: { color: Colors.textDim, fontSize: 11 },
  bar: { height: 3, borderRadius: 2, backgroundColor: Colors.surfaceBorder, marginTop: 2 },
  barFill: { height: 3, borderRadius: 2, backgroundColor: Colors.primary },
});
