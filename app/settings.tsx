import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { useXmpp } from '@/xmpp/XmppContext';
import { currentVersion, runCheck, startDownload, startInstall, updatesSupported, useUpdate } from '@/update/updater';
import { getStoredFleetSource, saveFleetSource } from '@/xmpp/fleet';

/** Cuerpo de ajustes; la pestaña Yo lo reutiliza. */
export function SettingsBody() {
  const { account, state, omemoEnabled, setOmemoEnabled } = useXmpp();
  const [changingOmemo, setChangingOmemo] = useState(false);

  const handleOmemoChange = useCallback(async (enabled: boolean) => {
    setChangingOmemo(true);
    try {
      await setOmemoEnabled(enabled);
    } catch (error) {
      Alert.alert('OMEMO', `No se pudo cambiar el cifrado: ${String(error)}`);
    } finally {
      setChangingOmemo(false);
    }
  }, [setOmemoEnabled]);

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Seguridad</Text>
      <View style={styles.settingRow}>
        <View style={styles.settingCopy}>
          <Text style={styles.settingTitle}>Cifrado OMEMO</Text>
          <Text style={styles.settingHint}>
            OMEMO 1 compatible con Rolando, Gajim y Dino. Cambiarlo reconecta la sesión XMPP.
          </Text>
          {account && <Text style={styles.account}>{account.jid}</Text>}
        </View>
        {changingOmemo ? (
          <ActivityIndicator size="small" color={Colors.primary} />
        ) : (
          <Switch
            value={omemoEnabled}
            onValueChange={(enabled) => { void handleOmemoChange(enabled); }}
            disabled={!account || state === 'connecting'}
            trackColor={{ false: Colors.surfaceBorder, true: Colors.primary }}
            accessibilityLabel="Cifrado OMEMO"
          />
        )}
      </View>
      {updatesSupported && <UpdateSettings />}
      <FleetSourceSettings />
    </View>
  );
}

/** Actualizaciones in-app (solo Android): buscar, descargar con progreso, instalar. */
function UpdateSettings() {
  const { state, info, progress, error } = useUpdate();
  const busy = state === 'checking' || state === 'downloading';
  const hasUpdate = info && (state === 'available' || state === 'downloading' || state === 'downloaded' || (state === 'error' && info));
  return (
    <>
      <Text style={[styles.sectionTitle, styles.sectionGap]}>Actualizaciones</Text>
      <View style={[styles.settingRow, styles.column]}>
        <Text style={styles.settingTitle}>Versión actual {currentVersion()}</Text>
        {state === 'uptodate' && <Text style={styles.settingHint}>Ya tienes la última versión.</Text>}
        {state === 'error' && error && <Text style={[styles.settingHint, { color: Colors.error }]}>{error}</Text>}
        {hasUpdate && (
          <>
            <Text style={styles.settingTitle}>Nueva versión {info.version}</Text>
            {info.notes !== '' && <Text style={styles.settingHint} numberOfLines={6}>{info.notes}</Text>}
          </>
        )}
        {state === 'downloading' && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>
        )}
        <View style={styles.buttonRow}>
          {state === 'downloaded' ? (
            <TouchableOpacity style={styles.button} onPress={() => { void startInstall(); }} accessibilityRole="button">
              <Text style={styles.buttonText}>Instalar</Text>
            </TouchableOpacity>
          ) : hasUpdate ? (
            <TouchableOpacity style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={() => { void startDownload(); }} accessibilityRole="button">
              <Text style={styles.buttonText}>{state === 'downloading' ? `Descargando ${Math.round(progress * 100)}%` : 'Descargar e instalar'}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={() => { void runCheck(); }} accessibilityRole="button">
            <Text style={styles.buttonText}>{state === 'checking' ? 'Buscando…' : 'Buscar actualizaciones'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </>
  );
}

/** Fuente del snapshot de flota (como el diálogo de xat): da el botón de cerebro de cada agente. */
function FleetSourceSettings() {
  const [jid, setJid] = useState('');
  const [node, setNode] = useState('');
  useEffect(() => {
    getStoredFleetSource().then((s) => { if (s) { setJid(s.jid); setNode(s.node); } }).catch(() => {});
  }, []);
  const save = useCallback(() => {
    const j = jid.trim();
    const n = node.trim();
    if ((j || n) && (j.indexOf('@') <= 0 || !n)) {
      Alert.alert('Flota', 'Indica un JID y un nodo PubSub válidos');
      return;
    }
    saveFleetSource(j, n)
      .then(() => Alert.alert('Flota', j ? 'Fuente de flota guardada' : 'Fuente de flota borrada'))
      .catch((e) => Alert.alert('Flota', String(e)));
  }, [jid, node]);
  return (
    <>
      <Text style={[styles.sectionTitle, styles.sectionGap]}>Flota</Text>
      <View style={[styles.settingRow, styles.column]}>
        <Text style={styles.settingHint}>Monitor de flota (JID y nodo PubSub). Activa el botón de cerebro de los agentes.</Text>
        <TextInput style={styles.input} value={jid} onChangeText={setJid} placeholder="operator@hablar.fuentelibre.org"
          placeholderTextColor={Colors.textDim} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
        <TextInput style={styles.input} value={node} onChangeText={setNode} placeholder="joework/monitoring/owner"
          placeholderTextColor={Colors.textDim} autoCapitalize="none" autoCorrect={false} />
        <TouchableOpacity style={styles.button} onPress={save} accessibilityRole="button">
          <Text style={styles.buttonText}>Guardar</Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingTop: 20,
  },
  sectionTitle: {
    color: Colors.secondary,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: 18,
    paddingBottom: 8,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 18,
    paddingVertical: 16,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  settingCopy: { flex: 1, gap: 4 },
  settingTitle: { color: Colors.text, fontSize: 16, fontWeight: '600' },
  settingHint: { color: Colors.textDim, fontSize: 13, lineHeight: 18 },
  account: { color: Colors.muted, fontSize: 12, marginTop: 3 },
  sectionGap: { marginTop: 24 },
  column: { flexDirection: 'column', alignItems: 'stretch', gap: 10 },
  input: { backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: 8, color: Colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  button: { alignSelf: 'flex-end', backgroundColor: Colors.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' },
  disabled: { opacity: 0.5 },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: Colors.surfaceBorder, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: Colors.primary },
  buttonText: { color: Colors.background, fontWeight: '700' },
});

export default function SettingsScreen() {
  return <SettingsBody />;
}
