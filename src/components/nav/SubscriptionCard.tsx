import { memo } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { acceptSubscription, declineSubscription } from '@/xmpp/roster';
import type { SubscriptionRequest } from '@/xmpp/subscriptions';
import { displayName } from '@/xmpp/presence';

const fail = (e: unknown) => Alert.alert('Suscripción', String(e));

/** Tarjeta de solicitud de suscripción (presence type=subscribe). */
export const SubscriptionCard = memo(function SubscriptionCard({ req }: { req: SubscriptionRequest }) {
  return (
    <View style={styles.card}>
      <Text style={styles.text}>{displayName(req.bare)} quiere suscribirse a tu presencia</Text>
      <Text style={styles.sub} numberOfLines={1}>{req.bare}</Text>
      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.accept]} onPress={() => { void acceptSubscription(req.bare).catch(fail); }}>
          <Text style={styles.acceptText}>Aceptar</Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={() => { void declineSubscription(req.bare).catch(fail); }}>
          <Text style={styles.declineText}>Rechazar</Text>
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: { marginHorizontal: 12, marginTop: 8, padding: 12, borderRadius: 10, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.primary },
  text: { color: Colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: Colors.muted, fontSize: 13, marginTop: 4 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  btn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: Colors.surfaceBorder },
  accept: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  acceptText: { color: Colors.background, fontWeight: '700' },
  declineText: { color: Colors.text },
});
