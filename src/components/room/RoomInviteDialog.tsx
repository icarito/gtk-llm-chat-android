import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Colors } from '@/constants/theme';
import { displayName } from '@/xmpp/presence';
import type { XmppContact } from '@/types/xmpp';

interface Props {
  visible: boolean;
  contacts: readonly XmppContact[];
  alreadyInvited: ReadonlySet<string>;
  onInvite: (jid: string, reason: string) => void;
  onClose: () => void;
}

export default function RoomInviteDialog({ visible, contacts, alreadyInvited, onInvite, onClose }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const candidates = useMemo(
    () => contacts.filter((c) => !alreadyInvited.has(c.jid)),
    [contacts, alreadyInvited],
  );

  const invite = () => {
    if (!selected) return;
    onInvite(selected, reason);
    setSelected(null);
    setReason('');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>Invitar a la sala</Text>
            <Pressable onPress={onClose}>
              <Text style={styles.close}>Cerrar</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            {candidates.length === 0 ? (
              <Text style={styles.empty}>No hay contactos para invitar.</Text>
            ) : (
              candidates.map((c) => {
                const jid = c.jid;
                const isSel = selected === jid;
                return (
                  <Pressable key={jid} style={[styles.row, isSel && styles.rowSelected]} onPress={() => setSelected(isSel ? null : jid)}>
                    <Text style={styles.rowName} numberOfLines={1}>{displayName(jid, c.name)}</Text>
                    <Text style={styles.rowJid} numberOfLines={1}>{jid}</Text>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
          <View style={styles.footer}>
            <TextInput
              style={styles.reason}
              value={reason}
              onChangeText={setReason}
              placeholder="Motivo (opcional)"
              placeholderTextColor={Colors.textDim}
            />
            <Pressable style={[styles.sendBtn, !selected && styles.sendBtnDisabled]} onPress={invite} disabled={!selected}>
              <Text style={[styles.sendText, !selected && styles.sendTextDisabled]}>Invitar</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000A', justifyContent: 'flex-end' },
  card: { backgroundColor: Colors.surface, borderTopLeftRadius: 14, borderTopRightRadius: 14, maxHeight: '80%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder },
  title: { color: Colors.text, fontSize: 16, fontWeight: '700' },
  close: { color: Colors.muted, fontSize: 14 },
  body: { padding: 8, maxHeight: 360 },
  empty: { color: Colors.muted, textAlign: 'center', padding: 30 },
  row: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8 },
  rowSelected: { backgroundColor: Colors.inputBackground },
  rowName: { color: Colors.text, fontSize: 15, fontWeight: '600' },
  rowJid: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16, borderTopWidth: 1, borderTopColor: Colors.surfaceBorder },
  reason: { flex: 1, backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: 8, padding: 10, color: Colors.text, fontSize: 14 },
  sendBtn: { backgroundColor: Colors.primary, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 },
  sendBtnDisabled: { backgroundColor: Colors.surfaceBorder },
  sendText: { color: Colors.background, fontWeight: '700', fontSize: 15 },
  sendTextDisabled: { color: Colors.muted },
});
