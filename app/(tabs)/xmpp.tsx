import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useXmpp } from '@/xmpp/XmppContext';
import { XmppService } from '@/xmpp/XmppService';
import { Colors } from '@/constants/theme';
import { displayName, presenceColor, presenceLabel } from '@/xmpp/presence';
import type { XmppContact, XmppMessage } from '@/types/xmpp';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const LAST_CHAT_KEY = '@gtk_llm_chat:last_chat_jid';

/** The server we're on — the roster's heading, e.g. hablar.fuentelibre.org */
function hostOf(jid: string): string {
  return jid.split('@')[1]?.split('/')[0] || jid;
}

function latestMessage(a?: XmppMessage, b?: XmppMessage): XmppMessage | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(a.timestamp).getTime() >= new Date(b.timestamp).getTime() ? a : b;
}

export default function XmppScreen() {
  const {
    state,
    contacts,
    messages,
    connect,
    disconnect,
    account,
    isConfigured,
  } = useXmpp();
  const [jid, setJid] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState('wss://hablar.fuentelibre.org:5281/xmpp-websocket');
  const [resource, setResource] = useState('gtk-llm-chat');
  // Avatares XEP-0084: llegan por PEP cuando el contacto los publica, así que
  // el roster tiene que repintarse al vuelo (no basta con leerlos al montar).
  const [avatars, setAvatars] = useState<Map<string, string>>(() => new Map());
  const [cachedPreviews, setCachedPreviews] = useState<Map<string, XmppMessage>>(() => new Map());
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const router = useRouter();
  const autoConnectAttempted = useRef(false);
  const contactJidsKey = useMemo(
    () => contacts.map((contact) => contact.jid).sort().join('\n'),
    [contacts],
  );
  // The header sits at the top of the screen with no navigation bar above it,
  // so it must clear the status bar itself.
  const insets = useSafeAreaInsets();

  const previewFor = useCallback(
    (jid: string) => {
      const history = messages.get(jid) || [];
      return latestMessage(history[history.length - 1], cachedPreviews.get(jid));
    },
    [messages, cachedPreviews],
  );

  // Roster por actividad reciente, como cualquier app de chat: la conversación
  // que se acaba de mover va arriba. Los contactos sin historial quedan al
  // final, por nombre, en vez de mezclarse entre las conversaciones vivas.
  const sortedContacts = useMemo(() => {
    const activityOf = (jid: string) => {
      const msg = previewFor(jid);
      if (!msg) return 0;
      const ms = new Date(msg.timestamp).getTime();
      return Number.isNaN(ms) ? 0 : ms;
    };
    return [...contacts].sort((a, b) => {
      const diff = activityOf(b.jid) - activityOf(a.jid);
      if (diff !== 0) return diff;
      return displayName(a.jid, a.name).localeCompare(displayName(b.jid, b.name));
    });
  }, [contacts, previewFor]);

  // Si el usuario terminó en el formulario con una cuenta ya guardada (logout
  // manual, o la sesión nunca llegó a autoconectar), no tiene sentido hacerlo
  // retipear JID y servidor — sólo la contraseña, que XmppContext no expone
  // fuera de XmppService por seguridad.
  useEffect(() => {
    if (!account) return;
    setJid((prev) => prev || account.jid);
    setServer((prev) => prev || account.service);
  }, [account]);

  useEffect(() => {
    // Sembramos con lo ya cacheado (los eventos PEP sólo llegan cuando el
    // contacto publica algo nuevo; uno que no cambió su avatar no emitiría).
    setAvatars((prev) => {
      const next = new Map(prev);
      for (const contact of contacts) {
        const uri = XmppService.getAvatarUri(contact.jid);
        if (uri) next.set(contact.jid, uri);
      }
      return next;
    });
    // Y preguntamos por los que aún no tenemos: quien publicó su avatar antes
    // de que nos conectáramos no emite ningún evento PEP.
    for (const contact of contacts) {
      if (!XmppService.getAvatarUri(contact.jid)) {
        void XmppService.fetchAvatar(contact.jid);
      }
    }
    const unsubscribe = XmppService.onAvatarChange((jid, uri) => {
      setAvatars((prev) => {
        const next = new Map(prev);
        if (uri) next.set(jid, uri);
        else next.delete(jid);
        return next;
      });
    });
    return () => { unsubscribe(); };
  }, [contacts]);

  // Auto-connect if account is configured
  useEffect(() => {
    if (isConfigured && state === 'disconnected' && !autoConnectAttempted.current) {
      autoConnectAttempted.current = true;
      connect('', '', '', '').catch(() => {});
    }
  }, [isConfigured, state, connect]);

  // Navigate to last chat after connect
  useEffect(() => {
    if (state === 'online' && autoConnectAttempted.current) {
      AsyncStorage.getItem(LAST_CHAT_KEY).then((lastJid) => {
        if (lastJid) {
          router.push({ pathname: '/xmpp-chat/[jid]', params: { jid: encodeURIComponent(lastJid) } } as never);
        }
      }).catch(() => {});
    }
  }, [state, router]);

  useEffect(() => {
    const contactJids = contactJidsKey ? contactJidsKey.split('\n') : [];
    if (state !== 'online' || contactJids.length === 0) {
      setCachedPreviews(new Map());
      return;
    }

    let cancelled = false;
    setLoadingPreviews(true);
    XmppService.loadCachedPreviews(contactJids)
      .then((previews) => {
        if (!cancelled) setCachedPreviews(previews);
      })
      .finally(() => {
        if (!cancelled) setLoadingPreviews(false);
      });

    return () => { cancelled = true; };
  }, [state, contactJidsKey]);

  const handleConnect = useCallback(async () => {
    if (!jid || !password) {
      Alert.alert('Error', 'JID y contraseña son requeridos.');
      return;
    }
    try {
      await connect(jid, password, server, resource);
    } catch (err) {
      Alert.alert('Error', `No se pudo conectar: ${String(err)}`);
    }
  }, [jid, password, server, resource, connect]);

  const handleChatWith = useCallback((contactJid: string) => {
    router.push({ pathname: '/xmpp-chat/[jid]', params: { jid: encodeURIComponent(contactJid) } } as never);
  }, [router]);

  // Spinner a pantalla completa sólo para el login inicial, sin roster ni
  // account todavía. Una reconexión automática (mismo estado 'connecting',
  // pero con account ya presente) no debe pasar por acá: ver el bloque de
  // abajo, que la mantiene sobre el roster con un banner en vez de éste.
  if (state === 'connecting' && !account) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={{ color: Colors.muted, marginTop: 16 }}>Conectando...</Text>
      </View>
    );
  }

  // Una vez que hubo sesión, quedarse en la lista de contactos aunque el
  // estado caiga a offline/error/connecting (reconexión automática en curso):
  // volver al formulario de login borraba el roster entero y no comunicaba
  // "reconectando", sólo "no hay nada acá".
  if ((state === 'online' || state === 'offline' || state === 'error' || state === 'connecting') && account) {
    const isReconnecting = state !== 'online';
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>{hostOf(account.jid)}</Text>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: isReconnecting ? Colors.error : Colors.success }]} />
              <Text style={styles.headerJid}>{account.jid}</Text>
              {loadingPreviews && <ActivityIndicator size="small" color={Colors.primary} />}
            </View>
          </View>
          <TouchableOpacity onPress={disconnect} style={styles.disconnectBtn}>
            <Ionicons name="power" size={20} color={Colors.error} />
          </TouchableOpacity>
        </View>

        {isReconnecting && (
          <View style={styles.reconnectBanner}>
            <ActivityIndicator size="small" color={Colors.text} />
            <Text style={styles.reconnectBannerText}>Desconectado — reconectando...</Text>
          </View>
        )}

        <FlatList
          data={sortedContacts}
          keyExtractor={(item) => item.jid}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No hay contactos aún.</Text>
              <Text style={styles.emptySubtext}>Agrega contactos desde otro cliente XMPP.</Text>
            </View>
          }
          renderItem={({ item }: { item: XmppContact }) => {
            const lastMsg = previewFor(item.jid);
            return (
              <TouchableOpacity
                style={styles.contactCard}
                onPress={() => handleChatWith(item.jid)}
              >
                <View style={styles.contactRow}>
                  <View style={styles.avatar}>
                    <View style={[styles.presenceIndicator, { backgroundColor: presenceColor(item.presence) }]} />
                    {avatars.get(item.jid) ? (
                      <Image source={{ uri: avatars.get(item.jid)! }} style={styles.avatarImage} />
                    ) : (
                      <Ionicons name="person" size={28} color={Colors.text} />
                    )}
                  </View>
                  <View style={styles.contactInfo}>
                    <Text style={styles.contactName} numberOfLines={1}>
                      {displayName(item.jid, item.name)}
                    </Text>
                    {/* Like the GTK roster: the contact's own status text when
                        they set one, otherwise fall back to their presence. */}
                    <Text style={styles.contactPresence} numberOfLines={1}>
                      {item.status || presenceLabel(item.presence)}
                    </Text>
                    {lastMsg && (
                      <Text style={styles.lastMessage} numberOfLines={1}>
                        {lastMsg.direction === 'out' ? 'Tú: ' : ''}{lastMsg.body}
                      </Text>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={() => handleChatWith(item.jid)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons name="chatbubble" size={24} color={Colors.primary} />
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>Cuenta XMPP</Text>
      </View>

      <View style={styles.formContainer}>
        <View style={styles.inputGroup}>
          <Text style={styles.label}>JID</Text>
          <TextInput
            style={styles.input}
            value={jid}
            onChangeText={setJid}
            placeholder="usuario@hablar.fuentelibre.org"
            placeholderTextColor={Colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={(state as string) !== 'connecting'}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Contraseña</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={Colors.textDim}
            secureTextEntry
            autoCapitalize="none"
            editable={(state as string) !== 'connecting'}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Servidor</Text>
          <TextInput
            style={styles.input}
            value={server}
            onChangeText={setServer}
            placeholder="xmpp://hablar.fuentelibre.org:5222"
            placeholderTextColor={Colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            editable={(state as string) !== 'connecting'}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Resource (opcional)</Text>
          <TextInput
            style={styles.input}
            value={resource}
            onChangeText={setResource}
            placeholder="gtk-llm-chat"
            placeholderTextColor={Colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            editable={(state as string) !== 'connecting'}
          />
        </View>

        <TouchableOpacity
          style={[styles.connectBtn, (state as string) === 'connecting' && styles.connectBtnDisabled]}
          onPress={handleConnect}
          disabled={(state as string) === 'connecting'}
        >
          {(state as string) === 'connecting' ? (
            <ActivityIndicator color={Colors.text} />
          ) : (
            <Text style={styles.connectBtnText}>Conectar</Text>
          )}
        </TouchableOpacity>

        {(state as string) === 'error' && (
          <Text style={styles.errorText}>Error de conexión. Verifica tus credenciales.</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  headerLeft: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: Colors.text,
  },
  headerJid: {
    fontSize: 13,
    color: Colors.muted,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  disconnectBtn: {
    padding: 8,
  },
  reconnectBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    backgroundColor: Colors.error,
  },
  reconnectBannerText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.text,
  },
  listContent: {
    paddingTop: 8,
  },
  contactCard: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    position: 'relative',
  },
  avatarImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.inputBackground,
  },
  presenceIndicator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: Colors.background,
    zIndex: 1,
  },
  contactInfo: {
    flex: 1,
  },
  contactName: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.text,
  },
  contactPresence: {
    fontSize: 13,
    color: Colors.muted,
    marginTop: 2,
  },
  lastMessage: {
    fontSize: 13,
    color: Colors.textDim,
    marginTop: 4,
  },
  empty: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: Colors.muted,
  },
  emptySubtext: {
    fontSize: 13,
    color: Colors.textDim,
    marginTop: 8,
  },
  formContainer: {
    padding: 24,
    gap: 16,
  },
  inputGroup: {
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.secondary,
  },
  input: {
    backgroundColor: Colors.inputBackground,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: Colors.text,
  },
  connectBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  connectBtnDisabled: {
    opacity: 0.6,
  },
  connectBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.background,
  },
  errorText: {
    color: Colors.error,
    fontSize: 14,
    textAlign: 'center',
  },
});
