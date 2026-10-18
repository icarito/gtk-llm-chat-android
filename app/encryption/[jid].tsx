import { useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { DeviceRow } from '@/components/encryption/DeviceRow';
import { Colors } from '@/constants/theme';
import { useOmemoDevices } from '@/hooks/useOmemoDevices';
import { omemo2Api } from '@/xmpp/omemo2';
import { displayName } from '@/xmpp/presence';

export default function EncryptionScreen() {
  const { jid } = useLocalSearchParams<{ jid: string }>();
  const peer = decodeURIComponent(jid ?? '');
  const own = useSyncExternalStore(omemo2Api.subscribe, () => omemo2Api.ownJid) ?? '';
  const peerDevices = useOmemoDevices(peer);
  const ownDevices = useOmemoDevices(own);
  const changes = useSyncExternalStore(omemo2Api.subscribeChanges, () => omemo2Api.identityChanges(peer));

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTitle: 'Cifrado',
          headerStyle: { backgroundColor: Colors.surface },
          headerTintColor: Colors.text,
        }}
      />
      {changes.length > 0 ? (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>La clave de identidad de un dispositivo cambió</Text>
          <Text style={styles.bannerText}>
            {`Dispositivos: ${changes.map((c) => c.rid).join(', ')}. Compara la huella con ${displayName(peer)} por otro canal antes de confiar.`}
          </Text>
        </View>
      ) : null}
      <Text style={styles.section}>{`Dispositivos de ${displayName(peer)}`}</Text>
      {peerDevices.length ? peerDevices.map((d) => <DeviceRow key={d.rid} device={d} />) : <Text style={styles.empty}>Sin dispositivos OMEMO conocidos.</Text>}
      <Text style={styles.section}>Mis dispositivos</Text>
      {ownDevices.length ? ownDevices.map((d) => <DeviceRow key={d.rid} device={d} />) : <Text style={styles.empty}>Sin dispositivos propios.</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 16, gap: 12 },
  section: { color: Colors.primary, fontSize: 14, fontWeight: '700', marginTop: 8 },
  empty: { color: Colors.muted },
  banner: { backgroundColor: '#3A1C1C', borderColor: Colors.error, borderWidth: 1, borderRadius: 8, padding: 12, gap: 4 },
  bannerTitle: { color: Colors.error, fontWeight: '700' },
  bannerText: { color: Colors.text, fontSize: 13 },
});
