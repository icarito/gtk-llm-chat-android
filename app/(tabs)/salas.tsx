import { memo, useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';
import { InviteCard } from '@/components/nav/InviteCard';
import { useRoomInvites, useRooms } from '@/xmpp/XmppContext';
import { joinRoom, leaveRoom, removeBookmark, setBookmark } from '@/xmpp/rooms';
import { displayName } from '@/xmpp/presence';
import type { XmppRoom } from '@/types/xmpp';

const fail = (e: unknown) => Alert.alert('Salas', String(e));

const STATE_LABEL: Record<XmppRoom['state'], string> = {
  joining: 'entrando…', joined: 'dentro', left: 'fuera', kicked: 'expulsado', banned: 'vetado', error: 'error',
};

const RoomRow = memo(function RoomRow({ room, onOpen, onOccupants }: {
  room: XmppRoom; onOpen: (jid: string) => void; onOccupants: (jid: string) => void;
}) {
  const active = room.state === 'joined' || room.state === 'joining';
  const toggleAutojoin = (value: boolean) => {
    setBookmark(room.jid, { nick: room.nick, name: room.name, autojoin: value }).catch(fail);
  };
  return (
    <Pressable
      style={styles.row}
      onPress={() => onOpen(room.jid)}
      onLongPress={() => {
        Alert.alert(room.name || room.jid, undefined, [
          active
            ? { text: 'Salir de la sala', onPress: () => { leaveRoom(room.jid).catch(fail); } }
            : { text: 'Entrar', onPress: () => { joinRoom(room.jid, room.nick || undefined).catch(fail); } },
          ...(room.bookmarked ? [{ text: 'Quitar marcador', style: 'destructive' as const, onPress: () => { removeBookmark(room.jid).catch(fail); } }] : []),
          { text: 'Cancelar', style: 'cancel' as const },
        ]);
      }}
    >
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>#{room.name || displayName(room.jid)}</Text>
        <Text style={styles.sub} numberOfLines={1}>
          {room.jid} · {room.state === 'error' && room.error ? room.error : STATE_LABEL[room.state]}
        </Text>
        {!!room.subject && <Text style={styles.subject} numberOfLines={1}>{room.subject}</Text>}
      </View>
      {room.state === 'joined' && (
        <Pressable onPress={() => onOccupants(room.jid)} hitSlop={10} accessibilityLabel="Ocupantes">
          <Ionicons name="people" size={22} color={Colors.primary} />
        </Pressable>
      )}
      {room.bookmarked && (
        <View style={styles.autojoin}>
          <Text style={styles.autojoinLabel}>Auto</Text>
          <Switch
            value={!!room.autojoin}
            onValueChange={toggleAutojoin}
            trackColor={{ false: Colors.surfaceBorder, true: Colors.primary }}
            accessibilityLabel="Entrar automáticamente"
          />
        </View>
      )}
    </Pressable>
  );
});

export default function SalasScreen() {
  const rooms = useRooms();
  const invites = useRoomInvites();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [jid, setJid] = useState('');

  const visible = useMemo(
    () => rooms
      .filter((r) => r.bookmarked || r.state === 'joined' || r.state === 'joining')
      .sort((a, b) => (a.name || a.jid).localeCompare(b.name || b.jid)),
    [rooms],
  );

  const open = useCallback((roomJid: string) => {
    router.push({ pathname: '/xmpp-chat/[jid]', params: { jid: encodeURIComponent(roomJid) } } as never);
  }, [router]);
  const occupants = useCallback((roomJid: string) => {
    router.push({ pathname: '/room/[jid]', params: { jid: encodeURIComponent(roomJid) } } as never);
  }, [router]);

  const join = () => {
    const target = jid.trim();
    if (!/^[^@\s/]+@[^@\s/]+$/.test(target)) {
      Alert.alert('Salas', 'Escribe el JID de la sala, por ejemplo sala@conference.servidor.org');
      return;
    }
    setJid('');
    joinRoom(target, undefined, { bookmark: true }).then(() => open(target)).catch(fail);
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>Salas</Text>
        <View style={styles.joinRow}>
          <TextInput
            style={styles.input}
            value={jid}
            onChangeText={setJid}
            placeholder="sala@conference.servidor.org"
            placeholderTextColor={Colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={join}
          />
          <Pressable style={styles.joinBtn} onPress={join}>
            <Text style={styles.joinText}>Entrar</Text>
          </Pressable>
        </View>
      </View>
      <FlatList
        data={visible}
        keyExtractor={(r) => r.jid}
        renderItem={({ item }) => <RoomRow room={item} onOpen={open} onOccupants={occupants} />}
        ListHeaderComponent={<>{invites.map((i) => <InviteCard key={i.id} invite={i} />)}</>}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No hay salas.</Text>
            <Text style={styles.emptySub}>Entra por JID o acepta una invitación.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { paddingHorizontal: 16, paddingBottom: 12, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder },
  title: { fontSize: 24, fontWeight: '700', color: Colors.text },
  joinRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  input: { flex: 1, backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: 8, paddingHorizontal: 12, color: Colors.text },
  joinBtn: { backgroundColor: Colors.primary, borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  joinText: { color: Colors.background, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder },
  info: { flex: 1 },
  name: { color: Colors.text, fontSize: 16, fontWeight: '600' },
  sub: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  subject: { color: Colors.textDim, fontSize: 13, marginTop: 2 },
  autojoin: { alignItems: 'center' },
  autojoinLabel: { color: Colors.muted, fontSize: 10 },
  empty: { padding: 40, alignItems: 'center' },
  emptyText: { fontSize: 16, color: Colors.muted },
  emptySub: { fontSize: 13, color: Colors.textDim, marginTop: 8 },
});
