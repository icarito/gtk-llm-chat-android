import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors } from '@/constants/theme';
import { useActiveCall } from '@/xmpp/jingle/callsStore';
import { answerCall, declineCall, hangup, setMicrophoneMuted } from '@/xmpp/jingle/manager';
import { displayName } from '@/xmpp/presence';

/** Overlay global de llamadas de audio (fase 1). Consume useActiveCall() y
 *  renderiza según dirección/fase; el manager limpia el store al terminar. */
export default function CallOverlay() {
  const call = useActiveCall();
  if (!call || call.phase === 'ended') return null;

  const name = displayName(call.peer);

  // La llamada falló (permiso de micrófono, ICE, término remoto): mostrar
  // algo, no desaparecer sin rastro. El manager la cierra solo en 4 s.
  if (call.phase === 'failed') {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => void hangup()}>
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <View style={[styles.callIcon, { backgroundColor: 'rgba(255,82,82,0.15)' }]}>
              <Ionicons name="close-circle" size={32} color={Colors.error} />
            </View>
            <Text style={styles.title}>Llamada fallida</Text>
            <Text style={styles.name}>{name}</Text>
            <Text style={styles.subtitle}>Se cierra en unos segundos</Text>
          </View>
        </View>
      </Modal>
    );
  }

  if (call.direction === 'incoming' && call.phase === 'ringing') {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => void hangup()}>
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <View style={styles.callIcon}>
              <Ionicons name="call" size={32} color={Colors.primary} />
            </View>
            <Text style={styles.title}>Llamada entrante</Text>
            <Text style={styles.name}>{name}</Text>
            <Text style={styles.subtitle}>Audio · 1:1</Text>
            <View style={styles.actions}>
              <Pressable style={[styles.button, styles.buttonGhost]} onPress={declineCall} accessibilityRole="button" accessibilityLabel="Rechazar llamada">
                <Text style={styles.buttonGhostText}>Rechazar</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.buttonPrimary]} onPress={answerCall} accessibilityRole="button" accessibilityLabel="Aceptar llamada">
                <Text style={styles.buttonPrimaryText}>Aceptar</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    );
  }

  if (call.direction === 'outgoing' && call.phase === 'ringing') {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => void hangup()}>
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <View style={styles.callIcon}>
              <Ionicons name="call" size={32} color={Colors.primary} />
            </View>
            <Text style={styles.title}>Llamando…</Text>
            <Text style={styles.name}>{name}</Text>
            <Pressable style={[styles.button, styles.buttonGhost]} onPress={() => void hangup()} accessibilityRole="button" accessibilityLabel="Cancelar llamada">
              <Text style={styles.buttonGhostText}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    );
  }

  if (call.phase === 'connecting') {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => void hangup()}>
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={styles.title}>Conectando…</Text>
            <Text style={styles.name}>{name}</Text>
            <Pressable style={[styles.button, styles.buttonGhost]} onPress={() => void hangup()} accessibilityRole="button" accessibilityLabel="Cancelar llamada">
              <Text style={styles.buttonGhostText}>Colgar</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    );
  }

  return <ActiveCall name={name} />;
}

function ActiveCall({ name }: { name: string }) {
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setMicrophoneMuted(next);
  };

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => void hangup()}>
      <View style={styles.activeScreen}>
        <Text style={styles.activeName}>{name}</Text>
        <Text style={styles.timer}>{mm}:{ss}</Text>
        <View style={styles.activeActions}>
          <Pressable
            style={[styles.roundButton, muted && styles.roundButtonMuted]}
            onPress={toggleMute}
            accessibilityRole="button"
            accessibilityLabel={muted ? 'Activar micrófono' : 'Silenciar micrófono'}
          >
            <Ionicons name={muted ? 'mic-off' : 'mic'} size={26} color={muted ? Colors.error : Colors.text} />
          </Pressable>
          <Pressable
            style={[styles.roundButton, styles.hangupButton]}
            onPress={() => void hangup()}
            accessibilityRole="button"
            accessibilityLabel="Colgar llamada"
          >
            <MaterialCommunityIcons name="phone-hangup" size={26} color="#FFFFFF" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  callIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.inputBackground,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  title: { color: Colors.text, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  name: { color: Colors.primary, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: Colors.textDim, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 16, alignSelf: 'stretch' },
  button: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  buttonPrimary: { backgroundColor: Colors.primary },
  buttonPrimaryText: { color: Colors.background, fontSize: 15, fontWeight: '700' },
  buttonGhost: { backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder },
  buttonGhostText: { color: Colors.text, fontSize: 15, fontWeight: '600' },
  activeScreen: { flex: 1, backgroundColor: Colors.background, alignItems: 'center', justifyContent: 'center', gap: 12 },
  activeName: { color: Colors.text, fontSize: 28, fontWeight: '700', textAlign: 'center', paddingHorizontal: 24 },
  timer: { color: Colors.textDim, fontSize: 20, fontVariant: ['tabular-nums'], marginBottom: 40 },
  activeActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 32 },
  roundButton: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  roundButtonMuted: { backgroundColor: 'rgba(255,82,82,0.15)', borderColor: Colors.error },
  hangupButton: { backgroundColor: Colors.error, borderColor: Colors.error },
});
