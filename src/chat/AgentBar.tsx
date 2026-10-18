import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Switch, Text, ToastAndroid, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { AgentActivityIndicator } from '@/components/agent/AgentActivityIndicator';
import { MindPanel, type MindCommand } from '@/components/agent/MindPanel';
import { Colors } from '@/constants/theme';
import { useAgentState, useRoom } from '@/xmpp/XmppContext';
import { XmppService } from '@/xmpp/XmppService';
import { presenceColor } from '@/xmpp/presence';
import { useConnectionState, useContact } from './stores';

const MAINTENANCE_RE = /abort|reset|restart|stop|clear|compact|new|kill|reiniciar|detener/i;
const ELEVATED_MINUTES = 10;

function notify(message: string) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert(message);
}

/** Interruptor de sesión elevada (bypass de aprobaciones); el servidor confirma el minutaje real. */
function ElevatedSwitch({ jid, online }: { jid: string; online: boolean }) {
  const [on, setOn] = useState(false);
  // El bypass expira solo en el servidor (sin push al cliente): se consulta una vez al abrir el panel.
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    XmppService.getElevatedSessionStatus(jid)
      .then(({ active }) => { if (!cancelled) setOn(active); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [jid, online]);

  const toggle = useCallback(async (next: boolean) => {
    setOn(next);
    try {
      notify(await XmppService.setElevatedSession(jid, next, ELEVATED_MINUTES));
    } catch (err) {
      setOn(!next);
      notify(String(err));
    }
  }, [jid]);

  return (
    <View style={styles.elevated}>
      <Ionicons name={on ? 'shield-checkmark' : 'shield-outline'} size={17} color={on ? Colors.warning : Colors.text} />
      <Text style={styles.elevatedLabel}>Bypass approvals</Text>
      <Switch value={on} onValueChange={toggle} disabled={!online} />
    </View>
  );
}

function AgentBarInner({ jid }: { jid: string }) {
  const [open, setOpen] = useState(false);
  const agent = useAgentState(jid);
  const contact = useContact(jid);
  const online = useConnectionState() === 'online';
  const [commands, setCommands] = useState<MindCommand[]>([]);

  // Los eventos PEP sólo llegan cuando el agente publica: pedir el valor actual
  // al enfocar y al (re)conectar (ver AGENTS.md).
  useFocusEffect(useCallback(() => {
    if (online) XmppService.fetchAgentTelemetry(jid);
  }, [jid, online]));

  useEffect(() => {
    if (!open || !online) return;
    let cancelled = false;
    XmppService.listAdhocCommands(jid)
      .then((list) => {
        if (cancelled) return;
        setCommands(list.map((c) => ({
          node: c.node,
          name: c.name,
          group: MAINTENANCE_RE.test(c.node) ? 'maintenance' : 'safe',
        })));
      })
      .catch(() => { if (!cancelled) setCommands([]); });
    return () => { cancelled = true; };
  }, [jid, open, online]);

  const onCommand = useCallback((node: string) => {
    XmppService.runAdhocCommand(jid, node)
      .then((result) => notify(result || `Comando ejecutado: ${node}`))
      .catch((err) => notify(String(err)));
  }, [jid]);

  const t = agent?.telemetry ?? undefined;
  const used = t?.context.used;
  const max = t?.context.max;
  const pct = used !== undefined && max ? Math.min(Math.round((used / max) * 100), 100) : undefined;
  const barColor = pct === undefined ? Colors.primary : pct > 90 ? Colors.error : pct > 75 ? Colors.warning : Colors.success;
  const timeline = useMemo(() => agent?.timeline ?? [], [agent?.timeline]);

  return (
    <View style={styles.bar}>
      <Pressable style={styles.strip} onPress={() => setOpen((v) => !v)} accessibilityRole="button">
        <View style={[styles.dot, { backgroundColor: presenceColor(contact?.presence ?? 'offline') }]} />
        <Text style={styles.model} numberOfLines={1}>{t?.model?.split('/').pop() ?? contact?.status ?? ''}</Text>
        <View style={styles.spacer} />
        <AgentActivityIndicator
          activity={agent?.activity}
          progressState={agent?.progress?.state}
          tool={agent?.tool}
        />
        {pct !== undefined ? <Text style={[styles.pct, { color: barColor }]}>{pct}%</Text> : null}
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textDim} />
      </Pressable>
      {pct !== undefined ? (
        <View style={styles.track}><View style={[styles.fill, { width: `${pct}%`, backgroundColor: barColor }]} /></View>
      ) : null}
      {open ? (
        <View style={styles.panel}>
          <MindPanel
            telemetry={t}
            pendingApprovals={agent?.pendingCount ?? 0}
            timeline={timeline}
            commands={commands}
            onCommand={onCommand}
          />
          <ElevatedSwitch jid={jid} online={online} />
        </View>
      ) : null}
    </View>
  );
}

/** Franja de estado del agente bajo el header; en salas (MUC) no hay agente que mostrar. */
function AgentBarImpl({ jid }: { jid: string }) {
  const room = useRoom(jid);
  return room ? null : <AgentBarInner jid={jid} />;
}

export const AgentBar = memo(AgentBarImpl);

const styles = StyleSheet.create({
  bar: { backgroundColor: Colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.surfaceBorder },
  strip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  model: { color: Colors.primary, fontSize: 11, fontWeight: '700', flexShrink: 1 },
  spacer: { flex: 1 },
  pct: { fontSize: 11, fontWeight: '700' },
  track: { height: 2, backgroundColor: Colors.surfaceBorder },
  fill: { height: 2 },
  panel: { padding: 10, gap: 8 },
  elevated: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  elevatedLabel: { flex: 1, color: Colors.text, fontSize: 14 },
});
