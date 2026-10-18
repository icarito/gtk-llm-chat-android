import { useCallback } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';
import { AgentCard } from '@/components/nav/AgentCard';
import { useAgentJids } from '@/components/nav/hooks';

export default function FlotaScreen() {
  const jids = useAgentJids();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const open = useCallback((jid: string) => {
    router.push({ pathname: '/xmpp-chat/[jid]', params: { jid: encodeURIComponent(jid) } } as never);
  }, [router]);
  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>Flota</Text>
      </View>
      <FlatList
        data={jids as string[]}
        keyExtractor={(jid) => jid}
        renderItem={({ item }) => <AgentCard jid={item} onPress={open} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Aún no hay agentes.</Text>
            <Text style={styles.emptySub}>Aparecen cuando publican su estado.</Text>
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
  empty: { padding: 40, alignItems: 'center' },
  emptyText: { fontSize: 16, color: Colors.muted },
  emptySub: { fontSize: 13, color: Colors.textDim, marginTop: 8 },
});
