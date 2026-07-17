import '../node-polyfills/crypto';
import '../node-polyfills/process';
import { useEffect } from 'react';
import { useFonts } from 'expo-font';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet } from 'react-native';
import { XmppProvider } from '@/xmpp/XmppContext';
import { setupNotifications, setAppForeground } from '@/xmpp/notifications';
import * as Notifications from 'expo-notifications';
import { Ionicons } from '@expo/vector-icons';
import * as SplashScreen from 'expo-splash-screen';

SplashScreen.preventAutoHideAsync().catch(() => {});

function routeFromNotification(notification: Notifications.Notification): void {
  const data = notification.request.content.data as { jid?: string; url?: string } | null;

  // Navegamos siempre por jid, nunca por la url del payload: el `url` viene
  // ya percent-encoded y expo-router lo decodifica al empujarlo, con lo que la
  // pantalla de chat (que espera el jid codificado) recibe basura y la ruta no
  // resuelve. Si sólo llega `url`, recuperamos el jid de su último segmento.
  let jid = typeof data?.jid === 'string' ? data.jid : '';
  if (!jid && typeof data?.url === 'string' && data.url.startsWith('/xmpp-chat/')) {
    jid = decodeURIComponent(data.url.slice('/xmpp-chat/'.length));
  }
  if (!jid) return;

  router.push({ pathname: '/xmpp-chat/[jid]', params: { jid: encodeURIComponent(jid) } } as never);
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(Ionicons.font);
  // La app nunca debe quedarse en el splash por culpa de la fuente de iconos.
  const fontsSettled = fontsLoaded || fontError !== null;

  useEffect(() => {
    if (fontsSettled) SplashScreen.hideAsync().catch(() => {});
  }, [fontsSettled]);

  useEffect(() => {
    setupNotifications().catch(() => {});

    let mounted = true;
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (mounted && response?.notification) routeFromNotification(response.notification);
      })
      .catch(() => {});

    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      routeFromNotification(response.notification);
    });

    const sub = AppState.addEventListener('change', (state) => {
      setAppForeground(state === 'active');
    });

    return () => {
      mounted = false;
      sub.remove();
      responseSub.remove();
    };
  }, []);

  if (!fontsSettled) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <XmppProvider>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: '#0A0E14' },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen
              name="xmpp-chat/[jid]"
              options={{
                headerShown: true,
                headerTitle: 'Chat',
                headerStyle: { backgroundColor: '#131822' },
                headerTintColor: '#E0E0E0',
              }}
            />
          </Stack>
        </XmppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
