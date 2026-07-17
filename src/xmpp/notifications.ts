import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { XmppMessage } from '@/types/xmpp';
import { PushStatus } from '@/xmpp/pushStatus';
import { displayName } from '@/xmpp/presence';

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
/** Chat abierto ahora mismo: sus mensajes no se notifican. */
let activeChatJid: string | null = null;
/** bare jid -> nombre del contacto, para el título de la notificación. */
const contactNameCache = new Map<string, string>();

// Copia local a propósito: XmppService ya importa este módulo, así que
// importar su bareJid crearía un ciclo.
function bareJid(full: string): string {
  return full.split('/')[0] ?? full;
}

// Called from AppState listener
export function setAppForeground(foreground: boolean) {
  isForeground = foreground;
}

/**
 * JID del chat abierto ahora mismo (o null). Mientras una conversación está
 * a la vista no tiene sentido notificar sus mensajes: la pantalla de chat lo
 * fija al entrar y lo limpia al salir.
 */
export function setActiveChatJid(jid: string | null) {
  activeChatJid = jid ? bareJid(jid) : null;
}

/**
 * Recuerda el nombre de cada contacto para que las notificaciones muestren
 * "Rolando" y no "rolando@hablar.fuentelibre.org". Se refresca con cada
 * cambio de roster.
 */
export function updateContactNameCache(contacts: { jid: string; name?: string }[]) {
  for (const contact of contacts) {
    if (!contact?.jid) continue;
    const name = contact.name?.trim();
    if (name) contactNameCache.set(bareJid(contact.jid), name);
    else contactNameCache.delete(bareJid(contact.jid));
  }
}

/**
 * Retira las notificaciones ya mostradas de una conversación. Se llama cuando
 * el mensaje se resolvió en otro sitio (p.ej. una corrección XEP-0308 retira
 * una pregunta): dejar el aviso colgado llevaría a un chat que ya no tiene
 * nada pendiente.
 */
export async function dismissNotificationForJid(jid: string): Promise<void> {
  const target = bareJid(jid);
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter((notification) => {
        const data = notification.request.content.data as { jid?: string } | null;
        return data?.jid ? bareJid(data.jid) === target : false;
      })
      .map((notification) =>
        Notifications.dismissNotificationAsync(notification.request.identifier)),
  );
}

/**
 * Un mensaje con <delay> (XEP-0203) es un replay: el servidor reenvía historial
 * al reconectar. Notificarlo produce una avalancha de avisos de conversaciones
 * viejas cada vez que la app recupera la conexión, así que sólo notificamos lo
 * que acaba de pasar. El gateway aplica este mismo corte.
 */
const REPLAY_MAX_AGE_MS = 10 * 60 * 1000;

/** Ids ya notificados: el mismo mensaje puede llegar en vivo y por carbon. */
const notifiedIds = new Set<string>();

function isReplay(msg: XmppMessage): boolean {
  const ts = new Date(msg.timestamp).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts > REPLAY_MAX_AGE_MS;
}

// Show notification for incoming XMPP message
export async function notifyXmppMessage(msg: XmppMessage, contactName?: string) {
  if (isForeground) return; // Don't notify when app is open
  // Tampoco notificar el chat que el usuario está mirando.
  if (activeChatJid && bareJid(msg.from) === activeChatJid) return;
  // Ni historial reenviado tras una reconexión.
  if (isReplay(msg)) return;
  if (msg.id) {
    if (notifiedIds.has(msg.id)) return;
    notifiedIds.add(msg.id);
    // Cota simple: sólo necesitamos memoria reciente para dedup.
    if (notifiedIds.size > 500) {
      for (const id of notifiedIds) {
        notifiedIds.delete(id);
        if (notifiedIds.size <= 250) break;
      }
    }
  }

  const title = displayName(msg.from, contactName || contactNameCache.get(bareJid(msg.from)))
    || 'Nuevo mensaje';
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
