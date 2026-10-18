import { useCallback, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useLocalSearchParams } from 'expo-router';
import { AgentBar } from '@/chat/AgentBar';
import { ChatHeaderTitle } from '@/chat/ChatHeaderTitle';
import { ChatPane } from '@/chat/ChatPane';
import { Colors } from '@/constants/theme';
import { dismissNotificationForJid, setActiveChatJid } from '@/xmpp/notifications';
import { XmppService } from '@/xmpp/XmppService';
import { useConnectionState } from '@/chat/stores';

const LAST_CHAT_KEY = '@gtk_llm_chat:last_chat_jid';

/**
 * Pantalla de chat: sólo compone. Cada pieza (header, barra del agente, lista)
 * se suscribe a lo suyo; esta pantalla no tiene estado, así que no re-renderiza
 * por mensajes, telemetría ni conexión.
 */
export default function XmppChatScreen() {
  const { jid } = useLocalSearchParams<{ jid: string }>();
  const decodedJid = decodeURIComponent(jid || '');

  // Suprime notificaciones locales mientras el chat está abierto y limpia las ya mostradas.
  useEffect(() => {
    setActiveChatJid(decodedJid);
    dismissNotificationForJid(decodedJid).catch(() => {});
    return () => setActiveChatJid(null);
  }, [decodedJid]);

  useEffect(() => {
    AsyncStorage.setItem(LAST_CHAT_KEY, decodedJid).catch(() => {});
  }, [decodedJid]);

  const headerTitle = useCallback(() => <ChatHeaderTitle jid={decodedJid} />, [decodedJid]);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerTitle,
          headerStyle: { backgroundColor: Colors.surface },
          headerTintColor: Colors.text,
        }}
      />
      <AutoReconnect />
      <AgentBar jid={decodedJid} />
      <ChatPane jid={decodedJid} />
    </View>
  );
}

/**
 * Un intento de reconexión por caída al entrar sin conexión; si falla, el
 * backoff del servicio es quien reintenta (relanzar desde aquí en cada cambio
 * creaba un bucle connecting→offline).
 */
function AutoReconnect() {
  const state = useConnectionState();
  useEffect(() => {
    if (state !== 'disconnected' && state !== 'offline') return;
    const account = XmppService.getAccount();
    if (account) XmppService.reconnectIfNeeded(account).catch(() => {});
  }, [state]);
  return null;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
});
