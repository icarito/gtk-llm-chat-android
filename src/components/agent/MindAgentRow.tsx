import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { AvatarWithPresence } from '@/chat/Avatar';
import { useConnectionState, useContact } from '@/chat/stores';
import { XmppService } from '@/xmpp/XmppService';
import { useAgentState } from '@/xmpp/XmppContext';
import { displayName, presenceColor, presenceLabel } from '@/xmpp/presence';
import { formatCost, formatTool } from '@/xmpp/pep/telemetry';
import { safeUrl, useBrainUrl } from '@/xmpp/fleet';
import { hookText, relativeTime } from './MindPanel';

const fmtN = (n?: number): string =>
  n === undefined
    ? '—'
    : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e4 ? `${Math.round(n / 1e3)}k`
    : n > 1e3 ? `${(n / 1e3).toFixed(1)}k`
    : String(n);

const ICONS: Record<string, string> = { activity: '●', progress: '▶', approval: '?', error: '!' };

/** Tarjeta de agente para la vista "Mente": actividad + stats de telemetría. */
export const MindAgentRow = memo(function MindAgentRow({ jid }: { jid: string }) {
  const contact = useContact(jid);
  const state = useAgentState(jid);
  const online = useConnectionState() === 'online';
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();
  const brain = safeUrl(useBrainUrl(jid));

  // PEP sólo emite cuando el agente publica: pedir el valor actual al verlo.
  useEffect(() => {
    if (online) void XmppService.fetchAgentTelemetry(jid);
  }, [jid, online]);

  const t = state?.telemetry;
  const used = t?.context.used;
  const max = t?.context.max;
  const pct = used !== undefined && max ? Math.min(Math.round((used / max) * 100), 100) : undefined;
  const activity = state?.activity || state?.availability || contact?.status || presenceLabel(contact?.presence ?? 'offline');
  const approvals = state ? [...state.approvals.values()].filter((a) => a.state === 'pending' && !a.decision).length : 0;
  const timeline = state?.timeline.slice(0, 5) ?? [];
  const presence = presenceColor(contact?.presence ?? 'offline');
  const model = t?.model || '—';

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Pressable style={styles.expand} onPress={() => setExpanded((v) => !v)} accessibilityRole="button">
          <View style={styles.avatarWrap}>
            <AvatarWithPresence jid={jid} name={contact?.name} size={40} presence={presence} ring={2.5} />
          </View>
          <View style={styles.info}>
            <Text style={styles.name} numberOfLines={1}>{displayName(jid, contact?.name)}</Text>
            <Text style={styles.activity} numberOfLines={1}>{activity}</Text>
          </View>
          {approvals > 0 ? (
            <Text style={styles.badge}>{approvals} aprobación{approvals > 1 ? 'es' : ''}</Text>
          ) : null}
          <Text style={styles.chevron}>{expanded ? '▴' : '▾'}</Text>
        </Pressable>
        {brain ? (
          <Pressable
            style={styles.brainBtn}
            onPress={() => router.push({ pathname: '/brain/[jid]', params: { jid: encodeURIComponent(jid) } } as never)}
            accessibilityRole="button"
            accessibilityLabel="Abrir el Brain del agente"
          >
            <Text style={styles.brainText}>Brain</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.stats}>
        {pct !== undefined ? (
          <>
            <View style={styles.bar}><View style={[styles.barFill, { width: `${pct}%` }]} /></View>
            <Text style={styles.statText}>contexto {fmtN(used)}/{fmtN(max)} ({pct}%)</Text>
          </>
        ) : <Text style={styles.statDim}>sin telemetría</Text>}
        <Text style={styles.statText}>modelo {model}</Text>
        <Text style={styles.statText}>tokens in {fmtN(t?.tokens.input)} · out {fmtN(t?.tokens.output)}</Text>
        <Text style={styles.statText}>costo {formatCost(t?.sessionCostUsd)} sesión · {formatCost(t?.dayCostUsd)} hoy</Text>
      </View>

      {expanded ? (
        <View style={styles.detail}>
          <Text style={styles.dimRow}>tool {formatTool(t?.tool)}</Text>
          {t?.sessionStatus ? <Text style={styles.dimRow}>sesión {t.sessionStatus}</Text> : null}
          {timeline.length > 0 ? (
            <View style={styles.timeline}>
              <Text style={styles.timelineTitle}>Actividad reciente</Text>
              {timeline.map((h, i) => (
                <View key={`${h.timestamp ?? ''}${i}`} style={styles.tlRow}>
                  <Text style={styles.tlText} numberOfLines={2}>{`${ICONS[h.event] ?? '·'} ${hookText(h)}`}</Text>
                  <Text style={styles.dimRight}>{relativeTime(h.timestamp, Date.now())}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  card: { backgroundColor: Colors.surface, borderRadius: 12, borderWidth: 1, borderColor: Colors.surfaceBorder, marginHorizontal: 12, marginTop: 10, padding: 12, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  expand: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  avatarWrap: { position: 'relative' },
  dot: { position: 'absolute', right: 0, bottom: 0, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: Colors.surface },
  info: { flex: 1 },
  name: { color: Colors.text, fontSize: 16, fontWeight: '600' },
  activity: { color: Colors.secondary, fontSize: 13, marginTop: 2 },
  badge: { color: Colors.warning, fontSize: 12, fontWeight: '700' },
  brainBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder },
  brainText: { color: Colors.primary, fontSize: 12, fontWeight: '700' },
  chevron: { color: Colors.textDim, fontSize: 14 },
  stats: { gap: 4 },
  bar: { height: 4, borderRadius: 2, backgroundColor: Colors.surfaceBorder },
  barFill: { height: 4, borderRadius: 2, backgroundColor: Colors.primary },
  statText: { color: Colors.text, fontSize: 12 },
  statDim: { color: Colors.textDim, fontSize: 12 },
  detail: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.surfaceBorder, paddingTop: 10, gap: 4 },
  dimRow: { color: Colors.textDim, fontSize: 12 },
  timeline: { marginTop: 6, gap: 3 },
  timelineTitle: { color: Colors.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  tlRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  tlText: { color: Colors.text, fontSize: 12, flex: 1 },
  dimRight: { color: Colors.textDim, fontSize: 11 },
});
