import '../node-polyfills/crypto';
import '../node-polyfills/process';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet } from 'react-native';
import { XmppProvider } from '@/xmpp/XmppContext';
import { setupNotifications, setAppForeground } from '@/xmpp/notifications';
import * as Notifications from 'expo-notifications';

function routeFromNotification(notification: Notifications.Notification): void {
  const url = notification.request.content.data?.url;
  if (typeof url === 'string' && url.startsWith('/xmpp-chat/')) {
    router.push(url as never);
    return;
  }

  const jid = notification.request.content.data?.jid;
  if (typeof jid === 'string' && jid.length > 0) {
    router.push({ pathname: '/xmpp-chat/[jid]', params: { jid: encodeURIComponent(jid) } } as never);
  }
}

export default function RootLayout() {
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
