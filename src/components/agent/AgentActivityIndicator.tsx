import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { Colors } from '@/constants/theme';
import { formatTool } from '@/xmpp/pep/telemetry';

export interface AgentActivityIndicatorProps {
  activity?: string;
  progressState?: 'start' | 'end';
  tool?: string;
}

/** Sólo refleja actividad real (hook/telemetría); en reposo no renderiza nada. */
export function AgentActivityIndicator({
  activity,
  progressState,
  tool,
}: AgentActivityIndicatorProps) {
  const busy = activity === 'processing' || activity === 'busy' || progressState === 'start';
  if (!busy) return null;
  const label = formatTool(tool) === 'ninguna' ? 'pensando…' : `pensando · ${formatTool(tool)}`;
  return (
    <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.text}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { color: Colors.primary, fontSize: 12, fontStyle: 'italic' },
});
