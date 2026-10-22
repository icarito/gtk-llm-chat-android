import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/theme';
import { useXmpp } from '@/xmpp/XmppContext';

const DEFAULT_SERVICE = 'wss://hablar.fuentelibre.org:5281/xmpp-websocket';
const DEFAULT_RESOURCE = 'gtk-llm-chat';

/** Formulario amigable de configuración de cuenta XMPP. Reutilizable: se muestra
 *  en Inicio cuando no hay cuenta y en la pestaña Yo. */
export function AccountForm() {
  const { connect, state, account } = useXmpp();
  const connecting = state === 'connecting';
  const [jid, setJid] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(DEFAULT_SERVICE);
  const [resource, setResource] = useState(DEFAULT_RESOURCE);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Si ya hay cuenta guardada (reconfiguración tras logout), precargar JID/servidor.
  const handleConnect = useCallback(async () => {
    const effectiveJid = jid || account?.jid || '';
    const effectiveServer = server || account?.service || DEFAULT_SERVICE;
    if (!effectiveJid || !password) {
      setError('Ingresá tu JID y contraseña.');
      return;
    }
    setError(null);
    try {
      await connect(effectiveJid, password, effectiveServer, resource || DEFAULT_RESOURCE, true);
    } catch (e) {
      setError(`No se pudo conectar: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jid, password, server, resource, account, connect]);

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <View style={styles.logoRing}>
          <Ionicons name="chatbubbles" size={40} color={Colors.primary} />
        </View>
        <Text style={styles.title}>Conéctate a tu cuenta XMPP</Text>
        <Text style={styles.subtitle}>
          Conversá con tus agentes de forma segura.{'\n'}
          Usá tu cuenta de hablar.fuentelibre.org o la de tu servidor.
        </Text>
      </View>

      <View style={styles.form}>
        <View style={styles.inputGroup}>
          <Text style={styles.label}>JID</Text>
          <TextInput
            style={styles.input}
            value={jid}
            onChangeText={(t) => { setJid(t); setError(null); }}
            placeholder="usuario@hablar.fuentelibre.org"
            placeholderTextColor={Colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={!connecting}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Contraseña</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={(t) => { setPassword(t); setError(null); }}
            placeholder="••••••••"
            placeholderTextColor={Colors.textDim}
            secureTextEntry
            autoCapitalize="none"
            editable={!connecting}
          />
        </View>

        <TouchableOpacity style={styles.advancedToggle} onPress={() => setShowAdvanced((v) => !v)} accessibilityRole="button">
          <Text style={styles.advancedToggleText}>{showAdvanced ? 'Ocultar opciones avanzadas' : 'Opciones avanzadas'}</Text>
          <Ionicons name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={14} color={Colors.textDim} />
        </TouchableOpacity>

        {showAdvanced && (
          <>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Servidor (WebSocket)</Text>
              <TextInput
                style={styles.input}
                value={server}
                onChangeText={setServer}
                placeholder={DEFAULT_SERVICE}
                placeholderTextColor={Colors.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!connecting}
              />
            </View>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Resource (opcional)</Text>
              <TextInput
                style={styles.input}
                value={resource}
                onChangeText={setResource}
                placeholder={DEFAULT_RESOURCE}
                placeholderTextColor={Colors.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!connecting}
              />
            </View>
          </>
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity style={[styles.connectBtn, connecting && styles.connectBtnDisabled]} onPress={() => { void handleConnect(); }} disabled={connecting} accessibilityRole="button">
          {connecting ? <ActivityIndicator color={Colors.text} /> : <Text style={styles.connectBtnText}>Conectar</Text>}
        </TouchableOpacity>

        <Text style={styles.hint}>
          ¿No tenés cuenta? Podés crear una en tu servidor XMPP (p. ej. hablar.fuentelibre.org) y usarla acá.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  hero: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 24 },
  logoRing: { width: 88, height: 88, borderRadius: 44, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.surfaceBorder, marginBottom: 16 },
  title: { color: Colors.text, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: Colors.muted, fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  form: { padding: 20, gap: 12, marginTop: 8 },
  inputGroup: { gap: 6 },
  label: { color: Colors.text, fontSize: 13, fontWeight: '600' },
  input: { backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: 10, color: Colors.text, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15 },
  advancedToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 },
  advancedToggleText: { color: Colors.primary, fontSize: 13, fontWeight: '600' },
  errorText: { color: Colors.error, fontSize: 13 },
  connectBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  connectBtnDisabled: { opacity: 0.6 },
  connectBtnText: { color: Colors.background, fontSize: 16, fontWeight: '700' },
  hint: { color: Colors.textDim, fontSize: 12, textAlign: 'center', lineHeight: 18, marginTop: 4 },
});
