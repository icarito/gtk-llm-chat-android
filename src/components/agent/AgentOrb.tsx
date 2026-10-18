import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

export interface AgentOrbProps {
  activity?: string;
  tool?: string;
  /** Sin telemetría (undefined) el orbe se ve apagado. */
  hasTelemetry?: boolean;
  connected?: boolean;
  /** 0..100: relleno de la barra de contexto bajo el orbe. */
  contextPct?: number;
  size?: number;
}

const BLUE = '#4FC3F7';
const CYAN = '#00E5FF';
const AMBER = '#FFD740';
const VIOLET = '#B388FF';
const GREY = '#607589';
const DESATURATED = '#4A545E';

/** Color y ritmo de pulso (ms por ciclo) según el estado, como en xat. */
export function orbStyle(
  activity: string | undefined,
  hasTelemetry: boolean,
  connected: boolean,
): { color: string; period: number } {
  if (!connected) return { color: DESATURATED, period: 0 };
  if (!hasTelemetry || !activity || activity === 'paused') return { color: GREY, period: 0 };
  switch (activity) {
    case 'available':
      return { color: BLUE, period: 4000 };
    case 'processing':
    case 'busy':
      return { color: CYAN, period: 900 };
    case 'pending':
      return { color: AMBER, period: 1200 };
    default:
      return { color: GREY, period: 0 };
  }
}

export function AgentOrb({
  activity,
  tool,
  hasTelemetry = true,
  connected = true,
  contextPct,
  size = 48,
}: AgentOrbProps) {
  const { color, period } = orbStyle(activity, hasTelemetry, connected);
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    pulse.setValue(0);
    if (!period) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: period / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: period / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [period, pulse]);

  const hasTool = connected && (tool ?? '').trim() !== '';
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  const glow = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.45] });
  const dot = Math.max(size / 6, 6);

  return (
    <View style={{ width: size * 1.4, alignItems: 'center' }} accessibilityRole="image">
      <View style={{ width: size * 1.4, height: size * 1.4, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View
          style={[
            styles.abs,
            { width: size * 1.3, height: size * 1.3, borderRadius: size, backgroundColor: color, opacity: glow },
          ]}
        />
        <Animated.View
          style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, transform: [{ scale }] }}
        />
        {hasTool ? (
          <View
            testID="orb-satellite"
            style={[styles.abs, { top: 0, right: 0, width: dot, height: dot, borderRadius: dot / 2, backgroundColor: VIOLET }]}
          />
        ) : null}
      </View>
      {contextPct !== undefined ? (
        <View style={[styles.bar, { width: size }]}>
          <View style={{ width: `${Math.min(Math.max(contextPct, 0), 100)}%`, height: 3, backgroundColor: color }} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
  bar: { height: 3, borderRadius: 2, backgroundColor: '#1E2A3A', overflow: 'hidden' },
});
