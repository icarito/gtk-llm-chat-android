import { memo } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { acceptInvite, declineInvite } from '@/xmpp/rooms';
import type { XmppRoomInvite } from '@/types/xmpp';
import { inviteText } from './rosterLogic';

const run = (p: Promise<void>) => p.catch((e) => Alert.alert('Invitación', String(e)));

export const InviteCard = memo(function InviteCard({ invite }: { invite: XmppRoomInvite }) {
  return (
    <View style={styles.card}>
      <Text style={styles.text}>{inviteText(invite)}</Text>
      {!!invite.reason && <Text style={styles.reason} numberOfLines={2}>{invite.reason}</Text>}
      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.accept]} onPress={() => { void run(acceptInvite(invite.id)); }}>
          <Text style={styles.acceptText}>Aceptar</Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={() => { void run(declineInvite(invite.id)); }}>
          <Text style={styles.declineText}>Rechazar</Text>
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: { marginHorizontal: 12, marginTop: 8, padding: 12, borderRadius: 10, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.primary },
  text: { color: Colors.text, fontSize: 15, fontWeight: '600' },
  reason: { color: Colors.muted, fontSize: 13, marginTop: 4 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  btn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: Colors.surfaceBorder },
  accept: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  acceptText: { color: Colors.background, fontWeight: '700' },
  declineText: { color: Colors.text },
});
