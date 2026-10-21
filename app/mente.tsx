import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';
import { useAgentJids } from '@/components/nav/hooks';
import { MindAgentRow } from '@/components/agent/MindAgentRow';

/** Vista "Mente": actividad y stats de todos los agentes (como xat). */
export default function MenteScreen() {
  const jids = useAgentJids();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>Mente</Text>
        <Text style={styles.subtitle}>Actividad y stats de los agentes</Text>
      </View>
      <FlatList
        data={jids as string[]}
        keyExtractor={(jid) => jid}
        renderItem={({ item }) => <MindAgentRow jid={item} />}
        contentContainerStyle={styles.content}
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
  subtitle: { fontSize: 13, color: Colors.textDim, marginTop: 2 },
  content: { paddingBottom: 32 },
  empty: { padding: 40, alignItems: 'center' },
  emptyText: { fontSize: 16, color: Colors.muted },
  emptySub: { fontSize: 13, color: Colors.textDim, marginTop: 8 },
});
