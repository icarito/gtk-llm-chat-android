import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Colors } from '@/constants/theme';
import { resolveBrainUrl } from '@/xmpp/fleet';
import { openExternalUrl } from '@/platform/openExternalUrl';

/** Brain integrado en web/Tauri (Linux). Siempre intenta el <iframe> (embebido);
 *  el botón inferior permite caer al navegador si el sitio bloquea framing
 *  (X-Frame-Options/CSP) o si se quiere sesión del navegador. */
export default function BrainScreenWeb() {
  const { jid } = useLocalSearchParams<{ jid: string }>();
  const decoded = decodeURIComponent(jid || '');
  const [uri, setUri] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    resolveBrainUrl(decoded).then((r) => {
      if (cancelled) return;
      setUri(r.url);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [decoded]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
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
        <Pressable style={styles.openBtn} onPress={() => openExternalUrl(uri)} accessibilityRole="button">
          <Text style={styles.openText}>Abrir en el navegador</Text>
        </Pressable>
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
  openBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20, alignItems: 'center' },
  openText: { color: Colors.background, fontWeight: '700', fontSize: 14 },
});
