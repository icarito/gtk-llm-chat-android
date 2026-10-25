import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';
import { AgentCard } from '@/components/nav/AgentCard';
import { useAgentJids } from '@/components/nav/hooks';
import { hasFleetSource } from '@/xmpp/fleet';
import { displayName } from '@/xmpp/presence';

export default function FlotaScreen() {
  const jids = useAgentJids();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();
  const filteredJids = trimmed
    ? jids.filter((jid) => displayName(jid).toLowerCase().includes(trimmed) || jid.toLowerCase().includes(trimmed))
    : jids;
  const open = useCallback((jid: string) => {
    router.push({ pathname: '/xmpp-chat/[jid]', params: { jid: encodeURIComponent(jid) } } as never);
  }, [router]);
  const openMonitor = useCallback(() => {
    router.push({ pathname: '/fleet' } as never);
  }, [router]);
  const openMente = useCallback(() => {
    router.push({ pathname: '/mente' } as never);
  }, [router]);
  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>Flota</Text>
        <View style={styles.headerActions}>
          <Pressable style={styles.monitorBtn} onPress={openMente} accessibilityRole="button">
            <Text style={styles.monitorText}>Mente</Text>
          </Pressable>
          <Pressable style={styles.monitorBtn} onPress={openMonitor} disabled={!hasFleetSource()} accessibilityRole="button">
            <Text style={[styles.monitorText, !hasFleetSource() && styles.monitorDisabled]}>Monitor</Text>
          </Pressable>
        </View>
      </View>
      <TextInput
        style={styles.search}
        placeholder="Buscar…"
        placeholderTextColor={Colors.textDim}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <FlatList
        data={filteredJids}
        keyExtractor={(jid) => jid}
        renderItem={({ item }) => <AgentCard jid={item} onPress={open} />}
        ListEmptyComponent={
          trimmed ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{`Sin resultados para "${query}".`}</Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>Aún no hay agentes.</Text>
              <Text style={styles.emptySub}>Aparecen cuando publican su estado.</Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { paddingHorizontal: 16, paddingBottom: 12, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 24, fontWeight: '700', color: Colors.text },
  headerActions: { flexDirection: 'row', gap: 8 },
  monitorBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: '#202A36', borderWidth: 1, borderColor: Colors.surfaceBorder },
  monitorText: { color: Colors.primary, fontSize: 13, fontWeight: '700' },
  monitorDisabled: { color: Colors.textDim },
  search: { marginHorizontal: 16, marginTop: 12, backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, color: Colors.text, fontSize: 14 },
  empty: { padding: 40, alignItems: 'center' },
  emptyText: { fontSize: 16, color: Colors.muted },
  emptySub: { fontSize: 13, color: Colors.textDim, marginTop: 8 },
});
