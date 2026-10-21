import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Colors } from '@/constants/theme';
import { resolveBrainUrl } from '@/xmpp/fleet';
import { openExternalUrl } from '@/platform/openExternalUrl';

/** Brain integrado en web/Tauri (Linux). Sólo se embebe con <iframe> cuando hay
 *  URL firmada (Ajustes → Brain); si no, se abre en el navegador externo. */
export default function BrainScreenWeb() {
  const { jid } = useLocalSearchParams<{ jid: string }>();
  const decoded = decodeURIComponent(jid || '');
  const [uri, setUri] = useState('');
  const [signed, setSigned] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveBrainUrl(decoded).then((r) => {
      if (cancelled) return;
      if (!r.signed && r.url) {
        void openExternalUrl(r.url);
        return;
      }
      setUri(r.url);
      setSigned(r.signed);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [decoded]);

  if (!signed) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.err}>Abriendo el Brain en el navegador…</Text>
      </View>
    );
  }

  if (!uri) {
    return (
      <View style={styles.center}>
        <Text style={styles.err}>Este agente no publicó un brain (https).</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <iframe src={uri} title="Brain del agente" style={styles.iframe} />
      <View style={styles.openWrap}>
        <Text style={styles.openHint}>¿El wiki bloquea el embebido?</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  iframe: { width: '100%', height: '100%', borderWidth: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  err: { color: Colors.textDim, fontSize: 14, textAlign: 'center' },
  openWrap: { position: 'absolute', bottom: 16, left: 16, right: 16, alignItems: 'center' },
  openHint: { color: Colors.textDim, fontSize: 12 },
});
