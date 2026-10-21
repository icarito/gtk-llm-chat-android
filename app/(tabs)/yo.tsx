import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';
import { pickAvatarImage } from '@/chat/attachPicker';
import { useXmpp } from '@/xmpp/XmppContext';
import { XmppService } from '@/xmpp/XmppService';
import { publishAvatar } from '@/xmpp/avatarPublish';
import { SettingsBody } from '../settings';

export default function YoScreen() {
  const { account, state, disconnect } = useXmpp();
  const insets = useSafeAreaInsets();
  const online = state === 'online';
  const bare = account?.jid.split('/')[0] ?? '';
  const [avatar, setAvatar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bare) return;
    setAvatar(XmppService.getAvatarUri(bare));
    if (online) void XmppService.fetchAvatar(bare);
    const off = XmppService.onAvatarChange((jid, uri) => { if (jid === bare) setAvatar(uri); });
    return () => { off(); };
  }, [bare, online]);

  const change = useCallback(async (source: 'camera' | 'gallery') => {
    setBusy(true);
    try {
      const img = await pickAvatarImage(source);
      if (img) await publishAvatar(bare, img.base64, img.mime, img.width, img.height);
    } catch (e) {
      Alert.alert('No se pudo cambiar la foto', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [bare]);

  const onAvatar = useCallback(() => {
    if (!online) { Alert.alert('Sin conexión', 'Conéctate para cambiar tu foto de perfil.'); return; }
    if (Platform.OS === 'web') { void change('gallery'); return; }
    Alert.alert('Foto de perfil', undefined, [
      { text: 'Cámara', onPress: () => { void change('camera'); } },
      { text: 'Galería', onPress: () => { void change('gallery'); } },
    ], { cancelable: true });
  }, [online, change]);
  return (
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>Yo</Text>
        <TouchableOpacity style={styles.avatar} onPress={onAvatar} disabled={busy || !account} accessibilityLabel="Cambiar foto de perfil">
          {busy ? <ActivityIndicator color={Colors.primary} />
            : avatar ? <Image source={{ uri: avatar }} style={styles.avatarImg} />
            : <Ionicons name="camera" size={28} color={Colors.muted} />}
        </TouchableOpacity>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: online ? Colors.success : Colors.error }]} />
          <Text style={styles.jid}>{account?.jid ?? 'Sin cuenta'}</Text>
        </View>
        {account && <Text style={styles.service}>{account.service}</Text>}
      </View>
      <SettingsBody />
      {account && (
        <TouchableOpacity style={styles.logout} onPress={() => { void disconnect(); }} accessibilityLabel="Desconectar">
          <Ionicons name="power" size={18} color={Colors.error} />
          <Text style={styles.logoutText}>Desconectar</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { paddingHorizontal: 16, paddingBottom: 12, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder },
  title: { fontSize: 24, fontWeight: '700', color: Colors.text },
  avatar: { width: 72, height: 72, borderRadius: 36, marginTop: 8, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surfaceBorder },
  avatarImg: { width: 72, height: 72 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  jid: { color: Colors.text, fontSize: 14 },
  service: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  logout: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 18 },
  logoutText: { color: Colors.error, fontSize: 16, fontWeight: '600' },
});
