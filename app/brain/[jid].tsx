import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useLocalSearchParams } from 'expo-router';
import { Colors } from '@/constants/theme';
import { resolveBrainUrl } from '@/xmpp/fleet';
import { openExternalUrl } from '@/platform/openExternalUrl';

/** Vista integrada del Brain del agente. Sólo se muestra embebida si hay una
 *  URL firmada con token configurada (Ajustes → Brain); si no, se abre en el
 *  navegador externo, donde la sesión ya existe (comportamiento previo). */
export default function BrainScreen() {
  const { jid } = useLocalSearchParams<{ jid: string }>();
  const decoded = decodeURIComponent(jid || '');
  const [uri, setUri] = useState<string>('');
  const [signed, setSigned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveBrainUrl(decoded).then((r) => {
      if (cancelled) return;
      if (!r.signed && r.url) {
        // Sin URL firmada: abrimos en el navegador (sesión ya existente).
        void openExternalUrl(r.url);
        return;
      }
      setUri(r.url);
      setSigned(r.signed);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [decoded]);

  const onShouldStartLoadWithRequest = useCallback((req: { url: string }) => {
    if (req.url === uri) return true;
    return req.url.startsWith('https://') && req.url.includes('fuentelibre');
  }, [uri]);

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
        {loading
          ? <ActivityIndicator size="large" color={Colors.primary} />
          : <Text style={styles.err}>Este agente no publicó un brain (https).</Text>}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {loading && <ActivityIndicator style={styles.spinner} size="large" color={Colors.primary} />}
      <WebView
        source={{ uri }}
        originWhitelist={['https://*']}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onLoadStart={() => { setError(null); setLoading(true); }}
        onLoadEnd={() => setLoading(false)}
        onError={() => { setLoading(false); setError('No se pudo cargar el Brain'); }}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        style={styles.web}
      />
      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  web: { flex: 1 },
  spinner: { position: 'absolute', top: '45%', alignSelf: 'center', zIndex: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  err: { color: Colors.textDim, fontSize: 14, textAlign: 'center' },
  errorBanner: { position: 'absolute', bottom: 12, left: 16, right: 16, color: Colors.error, textAlign: 'center' },
});
