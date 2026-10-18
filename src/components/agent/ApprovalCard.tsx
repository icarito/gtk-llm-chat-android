import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';

export interface ApprovalButton {
  label: string;
  value?: string;
  commandNode?: string;
  commandJid?: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
  kind: 'quick' | 'command';
}

/** Estado derivado del hook de aprobación (`state` + `decision`). */
export interface ApprovalDecision {
  state: string;
  decision?: string;
}

export interface ApprovalCardProps {
  title: string;
  detail?: string;
  command?: string;
  cwd?: string;
  buttons: ApprovalButton[];
  expiresAtMs?: number;
  decision?: ApprovalDecision;
  /** Reloj inyectable (tests); sin él, la card se refresca cada segundo. */
  nowMs?: number;
  onPress: (button: ApprovalButton) => void;
}

interface Seal {
  text: string;
  color: string;
}

const RED_UNDER_MS = 10_000;
const SEGMENTS = 12;

/** Mismo mapeo que xat (`seal_from_hook`). */
export function sealFor(d: ApprovalDecision): Seal | null {
  const dec = (d.decision ?? '').toLowerCase();
  switch (d.state) {
    case 'resolved':
      if (dec.startsWith('allow') || dec.startsWith('approve'))
        return { text: 'Aprobado', color: Colors.success };
      if (dec.startsWith('deny') || dec.startsWith('reject'))
        return { text: 'Rechazado', color: Colors.error };
      return { text: 'Resuelto', color: Colors.textDim };
    case 'expired':
      return { text: 'Expirado', color: Colors.textDim };
    case 'canceled':
      return { text: 'Cancelado', color: Colors.textDim };
    case 'failed':
      return { text: 'Falló', color: Colors.error };
    default:
      return null;
  }
}

/** Quick responses primero, comandos después; duplicados por etiqueta fuera. */
export function dedupeButtons(buttons: ApprovalButton[]): ApprovalButton[] {
  const ordered = [
    ...buttons.filter((b) => b.kind === 'quick'),
    ...buttons.filter((b) => b.kind !== 'quick'),
  ];
  const seen = new Set<string>();
  return ordered.filter((b) => {
    const key = b.label.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const buttonColors: Record<ApprovalButton['style'], { bg: string; fg: string }> = {
  primary: { bg: Colors.userBubble, fg: Colors.userBubbleText },
  secondary: { bg: Colors.surface, fg: Colors.text },
  success: { bg: Colors.success, fg: Colors.background },
  danger: { bg: Colors.error, fg: Colors.background },
};

/** Anillo sin SVG: 12 segmentos en círculo, se apagan al consumirse el plazo. */
function Ring({ frac, secs, color }: { frac: number; secs: number; color: string }) {
  const lit = Math.ceil(frac * SEGMENTS);
  const r = 13;
  return (
    <View
      style={styles.ring}
      accessible
      accessibilityRole="timer"
      accessibilityLabel={`caduca en ${secs} segundo${secs === 1 ? '' : 's'}`}
    >
      {Array.from({ length: SEGMENTS }, (_, i) => {
        const a = (i / SEGMENTS) * 2 * Math.PI - Math.PI / 2;
        return (
          <View
            key={i}
            style={[
              styles.seg,
              {
                left: 15 + r * Math.cos(a) - 2,
                top: 15 + r * Math.sin(a) - 2,
                backgroundColor: i < lit ? color : Colors.surfaceBorder,
              },
            ]}
          />
        );
      })}
      <Text style={[styles.ringText, { color }]}>{secs}</Text>
    </View>
  );
}

export function ApprovalCard({
  title,
  detail,
  command,
  cwd,
  buttons,
  expiresAtMs,
  decision,
  nowMs,
  onPress,
}: ApprovalCardProps) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (nowMs !== undefined || !expiresAtMs) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nowMs, expiresAtMs]);
  const now = nowMs ?? tick;

  // Total del plazo = lo que quedaba al primer render con expiración.
  const totalMs = useRef(0);
  const hasExpiry = expiresAtMs !== undefined && expiresAtMs > 0;
  if (hasExpiry && totalMs.current === 0) totalMs.current = Math.max(expiresAtMs - now, 1000);
  const left = hasExpiry ? Math.max(expiresAtMs - now, 0) : 0;

  const seal: Seal | null =
    (decision ? sealFor(decision) : null) ??
    (hasExpiry && left <= 0 ? { text: 'Expirado', color: Colors.textDim } : null);

  const pop = useRef(new Animated.Value(1.5)).current;
  const sealed = seal !== null;
  useEffect(() => {
    if (sealed) Animated.spring(pop, { toValue: 1, useNativeDriver: true }).start();
  }, [sealed, pop]);

  if (seal) {
    return (
      <View style={[styles.card, styles.cardSealed]}>
        <Animated.Text
          accessibilityRole="text"
          style={[styles.stamp, { color: seal.color, transform: [{ scale: pop }] }]}
        >
          {seal.text}
        </Animated.Text>
      </View>
    );
  }

  const color = left < RED_UNDER_MS ? Colors.error : Colors.warning;
  return (
    <View style={styles.card}>
      <View style={styles.top}>
        {hasExpiry ? (
          <Ring
            frac={Math.min(left / Math.max(totalMs.current, 1), 1)}
            secs={Math.ceil(left / 1000)}
            color={color}
          />
        ) : null}
        <View style={styles.flex}>
          <Text style={styles.title}>{title}</Text>
          {detail ? <Text style={styles.dim}>{detail}</Text> : null}
          {command ? <Text style={styles.mono}>{command}</Text> : null}
          {cwd ? <Text style={styles.mono}>{cwd}</Text> : null}
        </View>
      </View>
      <View style={styles.row}>
        {dedupeButtons(buttons).map((b) => {
          const c = buttonColors[b.style];
          return (
            <Pressable
              key={`${b.kind}:${b.label}`}
              accessibilityRole="button"
              accessibilityLabel={b.label}
              onPress={() => onPress(b)}
              style={[styles.button, { backgroundColor: c.bg }]}
            >
              <Text style={[styles.buttonText, { color: c.fg }]}>{b.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderColor: Colors.warning,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 10,
  },
  cardSealed: { borderColor: Colors.surfaceBorder, paddingVertical: 8 },
  top: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  title: { color: Colors.text, fontWeight: '700', fontSize: 15 },
  dim: { color: Colors.muted, fontSize: 13 },
  mono: { color: Colors.muted, fontFamily: 'monospace', fontSize: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    flexGrow: 1,
    minHeight: 40,
    minWidth: 64,
    borderRadius: 20,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontWeight: '600', fontSize: 14 },
  stamp: { fontWeight: '700', fontSize: 16, alignSelf: 'flex-start' },
  ring: { width: 30, height: 30 },
  seg: { position: 'absolute', width: 4, height: 4, borderRadius: 2 },
  ringText: {
    position: 'absolute',
    width: 30,
    textAlign: 'center',
    top: 8,
    fontSize: 10,
    fontWeight: '700',
  },
});
