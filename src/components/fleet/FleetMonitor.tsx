import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import {
  FRESHNESS_LABEL,
  STATE_LABEL,
  STATE_ORDER,
  countStates,
  ellipsize,
  entityType,
  freshnessState,
  stateColor,
  stateKey,
  stateTitle,
  stateTint,
} from '@/components/fleet/fleetFormat';
import { safeUrl, useFleetSnapshot, hasFleetSource } from '@/xmpp/fleet';
import type { FleetEntity, FleetOperation } from '@/xmpp/fleet';

function Header() {
  const snapshot = useFleetSnapshot();
  const fresh = freshnessState(snapshot);
  const color =
    fresh === 'stale' ? '#FF9E42' : fresh === 'live' ? '#4ADE80' : Colors.textDim;
  const stamp = snapshot.generatedAt || 'sin timestamp';
  return (
    <View style={styles.header}>
      <Text style={styles.kicker}>FLEET / XMPP MONITORING</Text>
      <Text style={styles.title}>Fleet monitor</Text>
      <Text style={[styles.freshness, { color }]} numberOfLines={1}>
        {FRESHNESS_LABEL[fresh]} · {ellipsize(stamp, 34)}
      </Text>
    </View>
  );
}

function StatGrid() {
  const snapshot = useFleetSnapshot();
  const counts = countStates(snapshot.entities);
  return (
    <View style={styles.grid}>
      {STATE_ORDER.map((s) => {
        const c = stateColor(s);
        return (
          <View key={s} style={[styles.statCard, { borderColor: `${c}55` }]}>
            <View style={[styles.rail, { backgroundColor: c }]} />
            <View style={styles.statCopy}>
              <Text style={styles.statLabel}>{STATE_LABEL[s]}</Text>
              <Text style={[styles.statValue, { color: c }]}>{counts[s]}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function CostCard() {
  const snapshot = useFleetSnapshot();
  const rows = snapshot.cost;
  return (
    <View style={[styles.card, styles.costCard]}>
      <Text style={styles.sectionTitle}>COST OBSERVED</Text>
      {rows.length === 0 ? (
        <Text style={styles.mutedLine}>No cost metrics</Text>
      ) : (
        <>
          {rows.slice(0, 2).map((r, i) => {
            const amount = String(r.value ?? '—');
            const currency = String(r.currency ?? r.unit ?? '');
            const instance = String(r.instance ?? '');
            const line = [amount, currency, instance].filter(Boolean).join(' · ');
            return (
              <Text key={`${i}-${line}`} style={styles.costLine} numberOfLines={1}>
                {ellipsize(line, 34)}
              </Text>
            );
          })}
          {rows.length > 2 && (
            <Text style={styles.mutedLine}>+{rows.length - 2} more metrics</Text>
          )}
        </>
      )}
    </View>
  );
}

function OperationsSection() {
  const snapshot = useFleetSnapshot();
  return (
    <View>
      <Text style={styles.sectionTitle}>CURRENT OPERATIONS</Text>
      {snapshot.operations.length === 0 ? (
        <Text style={styles.mutedLine}>No active operations</Text>
      ) : snapshot.operations.map((op, i) => <OperationRow key={i} op={op} />)}
    </View>
  );
}

function OperationRow({ op }: { op: FleetOperation }) {
  const detail = Object.entries(op.fields)
    .map(([k, v]) => `${k.replace(/_/g, ' ').toUpperCase()} ${v}`)
    .join('     ·     ');
  return (
    <View style={styles.opCard}>
      <Text style={styles.opTitle} numberOfLines={1}>{op.instance || 'Fleet operation'}</Text>
      <Text style={styles.opDetail} numberOfLines={2}>{detail}</Text>
    </View>
  );
}

function Inventory() {
  const snapshot = useFleetSnapshot();
  if (!hasFleetSource()) {
    return (
      <View>
        <Text style={styles.sectionTitle}>FLEET INVENTORY</Text>
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>Sin fuente configurada</Text>
          <Text style={styles.emptyDetail}>Configurá JID y nodo PubSub en Ajustes → Flota.</Text>
        </View>
      </View>
    );
  }
  return (
    <View>
      <Text style={styles.sectionTitle}>FLEET INVENTORY</Text>
      {snapshot.entities.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No snapshot received</Text>
          <Text style={styles.emptyDetail}>El nodo PubSub aún no publicó inventario.</Text>
        </View>
      ) : snapshot.entities.map((e, i) => <EntityRow key={i} entity={e} />)}
    </View>
  );
}

function EntityRow({ entity }: { entity: FleetEntity }) {
  const state = stateKey(entity);
  const color = stateColor(state);
  const label = String(entity.label ?? entity.team ?? entity.id ?? 'Unassigned');
  const id = String(entity.id ?? '');
  const jid = String(entity.jid ?? '');
  const life = String(entity.lifecycle ?? '—').replace(/_/g, ' ').toUpperCase();
  const type = entityType(entity).toUpperCase();
  const brain = safeUrl(entity['brain-url']);
  return (
    <View style={styles.entityCard}>
      <View style={[styles.rail, styles.entityRail, { backgroundColor: color }]} />
      <View style={styles.entityBody}>
        <Text style={styles.entityLabel} numberOfLines={1}>{label}</Text>
        <Text style={styles.entitySub} numberOfLines={1}>
          {ellipsize(id || jid || '—', 34)}
        </Text>
        <View style={styles.pillRow}>
          <View style={[styles.pill, { backgroundColor: '#202A36' }]}>
            <Text style={[styles.pillText, { color: Colors.secondary }]} numberOfLines={1}>{type}</Text>
          </View>
          <View style={[styles.pill, { backgroundColor: stateTint(state) }]}>
            <Text style={[styles.pillText, { color }]} numberOfLines={1}>{stateTitle(state)}</Text>
          </View>
          <View style={[styles.pill, { backgroundColor: '#1C222D' }]}>
            <Text style={[styles.pillText, { color: Colors.textDim }]} numberOfLines={1}>{life}</Text>
          </View>
        </View>
        {brain ? (
          <Text style={styles.brainLink} onPress={() => { void Linking.openURL(brain); }}>
            Brain
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export default function FleetMonitor() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Header />
      <StatGrid />
      <CostCard />
      <OperationsSection />
      <Inventory />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 14, paddingBottom: 32, gap: 14 },
  header: { marginBottom: 2 },
  kicker: { color: Colors.secondary, fontSize: 11, fontWeight: '600', letterSpacing: 1 },
  title: { color: Colors.text, fontSize: 22, fontWeight: '700', marginTop: 2 },
  freshness: { fontSize: 11, fontFamily: 'monospace', marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statCard: {
    width: '48.5%', flexGrow: 1, flexDirection: 'row', alignItems: 'center',
    gap: 10, padding: 12, borderRadius: 10, backgroundColor: '#151B24',
    borderWidth: 1,
  },
  rail: { width: 3, height: 40, borderRadius: 2 },
  entityRail: { height: '100%', alignSelf: 'stretch' },
  statCopy: { gap: 2, flex: 1 },
  statLabel: { color: Colors.textDim, fontSize: 10, fontWeight: '600', letterSpacing: 0.5 },
  statValue: { fontSize: 22, fontWeight: '700' },
  card: { borderRadius: 10, padding: 12, borderWidth: 1, borderColor: Colors.surfaceBorder, gap: 6 },
  costCard: { backgroundColor: '#332A19', borderColor: '#4A3A24' },
  sectionTitle: { color: Colors.secondary, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  mutedLine: { color: Colors.textDim, fontSize: 13 },
  costLine: { color: Colors.text, fontSize: 13, fontWeight: '600' },
  opCard: { backgroundColor: '#111720', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: Colors.surfaceBorder, gap: 3, marginBottom: 6 },
  opTitle: { color: Colors.text, fontSize: 13, fontWeight: '600' },
  opDetail: { color: Colors.textDim, fontSize: 11, fontFamily: 'monospace', lineHeight: 15 },
  emptyCard: { backgroundColor: '#111720', borderRadius: 10, padding: 16, borderWidth: 1, borderColor: Colors.surfaceBorder, gap: 4 },
  emptyTitle: { color: Colors.text, fontSize: 16, fontWeight: '600' },
  emptyDetail: { color: Colors.textDim, fontSize: 12 },
  entityCard: {
    flexDirection: 'row', backgroundColor: '#151B24', borderRadius: 10, borderWidth: 1,
    borderColor: Colors.surfaceBorder, marginBottom: 6, overflow: 'hidden',
  },
  entityBody: { flex: 1, padding: 12, gap: 4 },
  entityLabel: { color: Colors.text, fontSize: 14, fontWeight: '600' },
  entitySub: { color: Colors.textDim, fontSize: 11, fontFamily: 'monospace' },
  pillRow: { flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  pill: { borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3 },
  pillText: { fontSize: 10, fontWeight: '600' },
  brainLink: { color: Colors.primary, fontSize: 12, fontWeight: '600', marginTop: 4 },
});
