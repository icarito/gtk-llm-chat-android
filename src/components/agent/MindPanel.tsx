import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { openExternalUrl } from '@/platform/openExternalUrl';
import type { HookEvent } from '@/xmpp/pep/hooks';
import { formatCost, formatTool, type AgentTelemetry } from '@/xmpp/pep/telemetry';

export interface MindCommand {
  node: string;
  name: string;
  group: 'safe' | 'maintenance';
}

export interface MindPanelProps {
  telemetry?: AgentTelemetry;
  pendingApprovals: number;
  /** Más reciente primero; se muestran los 5 primeros. */
  timeline: HookEvent[];
  commands: MindCommand[];
  onCommand: (node: string) => void;
  /** brain-url https del agente (fleet snapshot); sin él no hay botón. */
  brainUrl?: string | null;
  /** Reloj inyectable para los tiempos relativos. */
  nowMs?: number;
}

const CONFIRM_MS = 3000;
const TIMELINE_VISIBLE = 5;
const ICONS: Record<string, string> = { activity: '●', progress: '▶', approval: '?', error: '!' };

const fmtN = (n?: number): string =>
  n === undefined ? 'sin dato' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n > 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

export function hookText(h: HookEvent): string {
  const detail = (h as { detail?: string }).detail;
  switch (h.event) {
    case 'activity':
      return `actividad · ${h.state || 'sin estado'}`;
    case 'progress':
      return `progreso · ${detail ?? h.state}`;
    case 'approval':
      return `aprobación · ${h.state || 'sin estado'}`;
    case 'error':
      return `error · ${detail ?? 'sin detalle'}`;
    default:
      return `${h.event} · ${h.state}`;
  }
}

export function relativeTime(timestamp: string | undefined, nowMs: number): string {
  const t = timestamp ? Date.parse(timestamp) : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(Math.round((nowMs - t) / 1000), 0);
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  return `hace ${Math.floor(s / 3600)} h`;
}

function Row({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, dim && styles.dim]}>{value}</Text>
    </View>
  );
}

function Chip({
  cmd,
  armed,
  onTap,
}: {
  cmd: MindCommand;
  armed: boolean;
  onTap: (c: MindCommand) => void;
}) {
  const label = armed ? '¿Seguro? toca de nuevo' : cmd.name;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onTap(cmd)}
      style={[styles.chip, armed && styles.chipArmed]}
    >
      <Text style={[styles.chipText, armed && { color: Colors.error }]}>{label}</Text>
    </Pressable>
  );
}

export function MindPanel({
  telemetry,
  pendingApprovals,
  timeline,
  commands,
  onCommand,
  nowMs,
  brainUrl,
}: MindPanelProps) {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const tap = (cmd: MindCommand) => {
    if (cmd.group === 'safe' || armed === cmd.node) {
      if (timer.current) clearTimeout(timer.current);
      setArmed(null);
      onCommand(cmd.node);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setArmed(cmd.node);
    timer.current = setTimeout(() => setArmed(null), CONFIRM_MS);
  };

  const now = nowMs ?? Date.now();
  const t = telemetry;
  const used = t?.context.used;
  const max = t?.context.max;
  const pct = used !== undefined && max ? Math.min(Math.round((used / max) * 100), 100) : undefined;
  const tool = formatTool(t?.tool);

  const chips = (group: MindCommand['group']) =>
    commands.filter((c) => c.group === group).map((c) => (
      <Chip key={c.node} cmd={c} armed={armed === c.node} onTap={tap} />
    ));

  return (
    <View style={styles.panel}>
      {pendingApprovals > 0 ? (
        <Text style={styles.badge} accessibilityRole="text">
          {pendingApprovals === 1
            ? '1 aprobación pendiente'
            : `${pendingApprovals} aprobaciones pendientes`}
        </Text>
      ) : null}
      {!t ? <Text style={styles.dim}>sin telemetría</Text> : null}
      <Row
        label="Contexto"
        value={pct === undefined ? 'sin dato' : `${fmtN(used)} / ${fmtN(max)} (${pct}%)`}
        dim={pct === undefined}
      />
      {pct !== undefined ? (
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${pct}%` }]} />
        </View>
      ) : null}
      <Row label="Tokens" value={`in ${fmtN(t?.tokens.input)} · out ${fmtN(t?.tokens.output)}`} />
      <Row label="Costo" value={formatCost(t?.cost.usd)} />
      <Row
        label="Sesión"
        value={`${formatCost(t?.sessionCostUsd)} sesión · ${formatCost(t?.dayCostUsd)} hoy${t?.sessionStatus ? ` · ${t.sessionStatus}` : ''}`}
      />
      <Row label="Tool" value={tool} dim={tool === 'ninguna'} />
      <Row label="Modelo" value={t?.model ?? 'sin dato'} dim={!t?.model} />

      {timeline.length > 0 ? (
        <View style={styles.timeline}>
          <Text style={styles.dim}>Actividad reciente</Text>
          {timeline.slice(0, TIMELINE_VISIBLE).map((h, i) => (
            <View key={`${h.timestamp ?? ''}${i}`} style={styles.row} testID="timeline-item">
              <Text style={styles.value}>{`${ICONS[h.event] ?? '·'} ${hookText(h)}`}</Text>
              <Text style={styles.dim}>{relativeTime(h.timestamp, now)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {brainUrl ? (
        <Pressable onPress={() => openExternalUrl(brainUrl)} accessibilityRole="link">
          <Text style={styles.value}>Abrir el cerebro del agente</Text>
        </Pressable>
      ) : null}
      <View style={styles.chips}>{chips('safe')}</View>
      <View style={styles.chips}>{chips('maintenance')}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: Colors.surface, padding: 12, gap: 6, borderRadius: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  label: { color: Colors.muted, fontSize: 13 },
  value: { color: Colors.text, fontSize: 13, flexShrink: 1 },
  dim: { color: Colors.textDim, fontSize: 12 },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: Colors.warning,
    color: Colors.background,
    fontWeight: '700',
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: 'hidden',
  },
  bar: { height: 4, borderRadius: 2, backgroundColor: Colors.surfaceBorder },
  barFill: { height: 4, borderRadius: 2, backgroundColor: Colors.primary },
  timeline: { marginTop: 6, gap: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: {
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.inputBackground,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipArmed: { borderColor: Colors.error },
  chipText: { color: Colors.text, fontSize: 13 },
});
