import '../node-polyfills/crypto';
import '../node-polyfills/process';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet } from 'react-native';
import { XmppProvider } from '@/xmpp/XmppContext';
import { setupNotifications, setAppForeground } from '@/xmpp/notifications';
import * as Notifications from 'expo-notifications';

export default function RootLayout() {
  const notificationListener = useRef<ReturnType<typeof Notifications.addNotificationResponseReceivedListener>>();

  useEffect(() => {
    setupNotifications();

    const sub = AppState.addEventListener('change', (state) => {
      setAppForeground(state === 'active');
    });

    return () => {
      sub.remove();
      if (notificationListener.current) {
        Notifications.removeNotificationSubscription(notificationListener.current);
      }
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
