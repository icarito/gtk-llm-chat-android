import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { XmppMessage } from '@/types/xmpp';
import { PushStatus } from '@/xmpp/pushStatus';

const PUSH_TOKEN_KEY = '@gtk_llm_chat:expo_push_token';
const XMPP_MESSAGES_CHANNEL = 'xmpp_messages';
const pushLog = globalThis.console;

export interface NotificationSetupResult {
  granted: boolean;
  expoPushToken: string | null;
}

function notificationUrlForJid(jid: string): string {
  return `/xmpp-chat/${encodeURIComponent(jid)}`;
}

async function ensureNotificationChannels(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(XMPP_MESSAGES_CHANNEL, {
      name: 'Mensajes XMPP',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#4FC3F7',
    });
  }
}

async function requestNotificationPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === 'granted') return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === 'granted';
}

async function resolveExpoPushToken(): Promise<string | null> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) {
    PushStatus.update({ token: 'error', error: 'Expo projectId no configurado' });
    pushLog.warn('[xmpp-push] Expo projectId not configured; remote push disabled');
    return null;
  }

  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
  PushStatus.update({ token: 'ready', error: null });
  pushLog.warn(`[xmpp-push] Expo push token acquired for project ${projectId}`);
  return token;
}

// Configure notification channels, permissions, and push token when available.
export async function setupNotifications(): Promise<NotificationSetupResult> {
  PushStatus.update({ token: 'requesting', error: null });
  pushLog.warn('[xmpp-push] Notification setup started');
  await ensureNotificationChannels();
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBubble: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  const granted = await requestNotificationPermission();
  if (!granted) {
    PushStatus.update({ token: 'denied', error: 'Permiso de notificaciones denegado' });
    pushLog.warn('[xmpp-push] Notification permission denied; remote push disabled');
    return { granted: false, expoPushToken: null };
  }

  try {
    return { granted: true, expoPushToken: await resolveExpoPushToken() };
  } catch (error) {
    PushStatus.update({ token: 'error', error: error instanceof Error ? error.message : String(error) });
    pushLog.warn('[xmpp-push] Failed to acquire Expo push token', error);
    return { granted: true, expoPushToken: null };
  }
}

export async function getStoredExpoPushToken(): Promise<string | null> {
  return AsyncStorage.getItem(PUSH_TOKEN_KEY);
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
      ...(Platform.OS === 'android' ? { channelId: XMPP_MESSAGES_CHANNEL } : {}),
      data: {
        jid: msg.from,
        type: 'xmpp_message',
        url: notificationUrlForJid(msg.from),
      },
      priority: Notifications.AndroidNotificationPriority.HIGH,
    },
    trigger: null,
  });
}
