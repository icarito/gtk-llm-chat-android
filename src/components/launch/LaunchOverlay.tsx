import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/theme';
import { useConnectionState } from '@/chat/stores';

const MAX_MS = 8000;

/** Pantalla de bienvenida brandeada: se muestra al arrancar hasta que la
 *  conexión XMPP queda online (o por un tiempo máximo, para no bloquear si no
 *  hay red). Se desvanece suavemente. */
export default function LaunchOverlay() {
  const online = useConnectionState() === 'online';
  const [hidden, setHidden] = useState(false);
  const opacity = useRef(new Animated.Value(1)).current;

  // Oculta SIEMPRE a los MAX_MS como máximo (timer absoluto), online o no:
  // si no hay cuenta (asistente de nuevo usuario/login) nunca llega online y,
  // sin esto, el overlay quedaría pegado tapando la app para siempre.
  useEffect(() => {
    const t = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 450, useNativeDriver: true }).start(() => setHidden(true));
    }, MAX_MS);
    return () => clearTimeout(t);
  }, [opacity]);

  // Si hay conexión, se oculta antes (apenas se confirma online).
  useEffect(() => {
    if (!online) return;
    const t = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 450, useNativeDriver: true }).start(() => setHidden(true));
    }, 350);
    return () => clearTimeout(t);
  }, [online, opacity]);

  if (hidden) return null;

  return (
    <Animated.View style={[styles.overlay, { opacity }]} pointerEvents="none">
      <View style={styles.logoRing}>
        <Ionicons name="chatbubbles" size={48} color={Colors.primary} />
      </View>
      <Text style={styles.title}>gtk-llm-chat</Text>
      <Text style={styles.tagline}>hablando con tus agentes, cifrado de punta a punta</Text>
      <View style={styles.dots}>
        {[0, 1, 2].map((i) => <Dot key={i} delay={i * 160} />)}
      </View>
    </Animated.View>
  );
}

function Dot({ delay }: { delay: number }) {
  const opacity = useRef(new Animated.Value(0.25)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.25, duration: 500, useNativeDriver: true }),
      ]),
    );
    const t = setTimeout(() => loop.start(), delay);
    return () => { clearTimeout(t); loop.stop(); };
  }, [opacity, delay]);
  return <Animated.View style={[styles.dot, { opacity }]} />;
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#0A0E14', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  logoRing: { width: 96, height: 96, borderRadius: 48, backgroundColor: '#131822', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.surfaceBorder, marginBottom: 20 },
  title: { color: Colors.text, fontSize: 26, fontWeight: '700', letterSpacing: 0.3 },
  tagline: { color: Colors.textDim, fontSize: 13, marginTop: 6, textAlign: 'center', paddingHorizontal: 40 },
  dots: { flexDirection: 'row', gap: 8, marginTop: 24 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.primary },
});
