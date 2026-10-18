import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';
import { useXmpp } from '@/xmpp/XmppContext';
import { SettingsBody } from '../settings';

export default function YoScreen() {
  const { account, state, disconnect } = useXmpp();
  const insets = useSafeAreaInsets();
  const online = state === 'online';
  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>Yo</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: online ? Colors.success : Colors.error }]} />
          <Text style={styles.jid}>{account?.jid ?? 'Sin cuenta'}</Text>
        </View>
        {account && <Text style={styles.service}>{account.service}</Text>}
      </View>
      <SettingsBody />
      {account && (
        <TouchableOpacity style={styles.logout} onPress={() => { void disconnect(); }} accessibilityLabel="Desconectar">
          <Ionicons name="power" size={18} color={Colors.error} />
          <Text style={styles.logoutText}>Desconectar</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { paddingHorizontal: 16, paddingBottom: 12, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder },
  title: { fontSize: 24, fontWeight: '700', color: Colors.text },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  jid: { color: Colors.text, fontSize: 14 },
  service: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  logout: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 18 },
  logoutText: { color: Colors.error, fontSize: 16, fontWeight: '600' },
});
