import { memo, useCallback, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Colors } from '@/constants/theme';
import { useRoom } from '@/xmpp/XmppContext';
import { ban, kick, setRole, setSubject } from '@/xmpp/moderation';
import { devicesLabel, groupOccupants, type OccupantGroup } from '@/xmpp/xep/occupants';
import { roleWord } from '@/components/nav/rosterLogic';
import type { MucRole } from '@/xmpp/xep/muc';

const fail = (e: unknown) => Alert.alert('Sala', String(e));

const ROLE_WORD: Record<string, string> = { moderator: 'Moderador', participant: 'Participante', visitor: 'Visitante', none: 'Sin rol' };

const Row = memo(function Row({ group, onLongPress }: { group: OccupantGroup; onLongPress: (g: OccupantGroup) => void }) {
  const devices = group.devices > 1 ? ` · ${devicesLabel(group.devices)}` : '';
  return (
    <Pressable style={styles.row} onLongPress={() => onLongPress(group)}>
      <Text style={styles.name} numberOfLines={1}>{group.nicks[0]}</Text>
      <Text style={styles.sub} numberOfLines={1}>{roleWord(group.role, group.affiliation)}{devices}</Text>
    </Pressable>
  );
});

export default function RoomOccupantsScreen() {
  const { jid: raw } = useLocalSearchParams<{ jid: string }>();
  const jid = decodeURIComponent(raw ?? '');
  const room = useRoom(jid);
  const [target, setTarget] = useState<OccupantGroup | null>(null);
  const [subject, setSubjectText] = useState<string | null>(null);

  const sections = useMemo(() => {
    const { agents, people } = groupOccupants(Object.values(room?.occupants ?? {}));
    return [
      { title: `Agentes (${agents.length})`, data: agents },
      { title: `Personas (${people.length})`, data: people },
    ].filter((s) => s.data.length > 0);
  }, [room?.occupants]);

  const longPress = useCallback((g: OccupantGroup) => setTarget(g), []);
  const nick = target?.nicks[0] ?? '';
  const realJid = target?.key.startsWith('nick:') ? undefined : target?.key;
  // Moderar exige ser moderador o admin/owner; si no, el servidor lo rechazaría.
  const canModerate = room?.role === 'moderator' || room?.affiliation === 'admin' || room?.affiliation === 'owner';
  const act = (p: Promise<void>) => { setTarget(null); p.catch(fail); };

  const actions: { label: string; danger?: boolean; run: () => void }[] = !target || !canModerate ? [] : [
    { label: 'Expulsar', run: () => act(kick(jid, nick)) },
    ...(realJid ? [{ label: 'Vetar', danger: true, run: () => act(ban(jid, realJid)) }] : []),
    ...(['moderator', 'participant', 'visitor'] as MucRole[])
      .filter((r) => r !== target.role)
      .map((r) => ({ label: `Hacer ${ROLE_WORD[r]?.toLowerCase()}`, run: () => act(setRole(jid, nick, r)) })),
  ];

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: true, headerTitle: room?.name || jid, headerStyle: { backgroundColor: Colors.surface }, headerTintColor: Colors.text }} />
      <View style={styles.subjectBox}>
        {subject === null ? (
          <Pressable onPress={() => canModerate && setSubjectText(room?.subject ?? '')}>
            <Text style={styles.subjectLabel}>Asunto{canModerate ? ' (toca para editar)' : ''}</Text>
            <Text style={styles.subject}>{room?.subject || 'Sin asunto'}</Text>
          </Pressable>
        ) : (
          <View style={styles.subjectEdit}>
            <TextInput style={styles.input} value={subject} onChangeText={setSubjectText} autoFocus placeholderTextColor={Colors.textDim} />
            <Pressable onPress={() => { setSubject(jid, subject).catch(fail); setSubjectText(null); }}>
              <Text style={styles.save}>Guardar</Text>
            </Pressable>
          </View>
        )}
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(g) => g.key}
        renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
        renderItem={({ item }) => <Row group={item} onLongPress={longPress} />}
        ListEmptyComponent={<Text style={styles.empty}>{room?.state === 'joined' ? 'No hay ocupantes.' : 'Entra a la sala para ver quién está.'}</Text>}
      />
      <Modal transparent visible={actions.length > 0} animationType="fade" onRequestClose={() => setTarget(null)}>
        <Pressable style={styles.backdrop} onPress={() => setTarget(null)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{nick}</Text>
            {actions.map((a) => (
              <Pressable key={a.label} style={styles.action} onPress={a.run}>
                <Text style={[styles.actionText, a.danger && { color: Colors.error }]}>{a.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  subjectBox: { padding: 16, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder },
  subjectLabel: { color: Colors.muted, fontSize: 12 },
  subject: { color: Colors.text, fontSize: 15, marginTop: 2 },
  subjectEdit: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  input: { flex: 1, backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: 8, padding: 10, color: Colors.text },
  save: { color: Colors.primary, fontWeight: '700' },
  section: { color: Colors.secondary, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  row: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder },
  name: { color: Colors.text, fontSize: 16, fontWeight: '600' },
  sub: { color: Colors.muted, fontSize: 13, marginTop: 2 },
  empty: { color: Colors.muted, textAlign: 'center', padding: 40 },
  backdrop: { flex: 1, backgroundColor: '#000A', justifyContent: 'flex-end' },
  sheet: { backgroundColor: Colors.surface, padding: 16, borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  sheetTitle: { color: Colors.muted, fontSize: 13, marginBottom: 8 },
  action: { paddingVertical: 14 },
  actionText: { color: Colors.text, fontSize: 16 },
});
