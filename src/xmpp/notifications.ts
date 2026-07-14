import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { XmppMessage } from '@/types/xmpp';

// Configure notification channel
export async function setupNotifications() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('xmpp_messages', {
      name: 'Mensajes XMPP',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#4FC3F7',
    });
  }

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBubble: true,
    }),
  });
}

// Track if app is in foreground
let isForeground = true;

// Called from AppState listener
export function setAppForeground(foreground: boolean) {
  isForeground = foreground;
}

// Show notification for incoming XMPP message
export async function notifyXmppMessage(msg: XmppMessage, contactName?: string) {
  if (isForeground) return; // Don't notify when app is open

  const title = contactName || msg.from || 'Nuevo mensaje';
  const body = msg.body.length > 200 ? msg.body.slice(0, 197) + '...' : msg.body;

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: 'default',
      data: { jid: msg.from, type: 'xmpp_message' },
      priority: Notifications.AndroidNotificationPriority.HIGH,
    },
    trigger: null, // immediate
  });
}
