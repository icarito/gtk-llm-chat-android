import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useXmpp } from '@/xmpp/XmppContext';
import { Colors } from '@/constants/theme';
import type { XmppContact } from '@/types/xmpp';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const LAST_CHAT_KEY = '@gtk_llm_chat:last_chat_jid';

/** The server we're on — the roster's heading, e.g. hablar.fuentelibre.org */
function hostOf(jid: string): string {
  return jid.split('@')[1]?.split('/')[0] || jid;
}

// Presence is binary here, matching the GTK client's _presence_dot: a contact
// is either available or not. away/dnd/xa all read as "not online".
function isOnline(presence: string): boolean {
  return presence === 'online';
}

function presenceColor(presence: string): string {
  return isOnline(presence) ? Colors.success : Colors.muted;
}

function presenceLabel(presence: string): string {
  return isOnline(presence) ? 'En línea' : 'Desconectado';
}

export default function XmppScreen() {
  const { state, contacts, messages, connect, disconnect, account, isConfigured } = useXmpp();
  const [jid, setJid] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState('wss://hablar.fuentelibre.org:5281/xmpp-websocket');
  const [resource, setResource] = useState('gtk-llm-chat');
  const router = useRouter();
  const autoConnectAttempted = useRef(false);
  // The header sits at the top of the screen with no navigation bar above it,
  // so it must clear the status bar itself.
  const insets = useSafeAreaInsets();

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

  // Show connecting spinner while auto-connecting or manual connecting
  if (state === 'connecting') {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={{ color: Colors.muted, marginTop: 16 }}>Conectando...</Text>
      </View>
    );
  }

  if (state === 'online' && account) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>{hostOf(account.jid)}</Text>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: Colors.success }]} />
              <Text style={styles.headerJid}>{account.jid}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={disconnect} style={styles.disconnectBtn}>
            <Ionicons name="power" size={20} color={Colors.error} />
          </TouchableOpacity>
        </View>

        <FlatList
          data={contacts}
          keyExtractor={(item) => item.jid}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No hay contactos aún.</Text>
              <Text style={styles.emptySubtext}>Agrega contactos desde otro cliente XMPP.</Text>
            </View>
          }
          renderItem={({ item }: { item: XmppContact }) => {
            const msgHistory = messages.get(item.jid) || [];
            const lastMsg = msgHistory[msgHistory.length - 1];
            return (
              <TouchableOpacity
                style={styles.contactCard}
                onPress={() => handleChatWith(item.jid)}
              >
                <View style={styles.contactRow}>
                  <View style={styles.avatar}>
                    <View style={[styles.presenceIndicator, { backgroundColor: presenceColor(item.presence) }]} />
                    <Ionicons name="person" size={28} color={Colors.text} />
                  </View>
                  <View style={styles.contactInfo}>
                    <Text style={styles.contactName} numberOfLines={1}>
                      {item.name || item.jid}
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
