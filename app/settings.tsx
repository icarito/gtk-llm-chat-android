import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Switch, Text, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { useXmpp } from '@/xmpp/XmppContext';

export default function SettingsScreen() {
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
    </View>
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
});
