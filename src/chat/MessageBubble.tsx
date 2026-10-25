import { memo, useState, type ReactNode } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import type { MessageState } from '@assistant-ui/react-native';
import { Colors } from '@/constants/theme';
import { XmppService } from '@/xmpp/XmppService';
import { AudioBubbleForMessage } from './AudioBubble';
import { MessageExtras } from './MessageExtras';
import { MessageBody } from './richText';
import { ME, type ChatMessage } from './toIMessage';
import { Avatar } from './Avatar';
import { useCtx } from './Composer';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉'] as const;

const formatTime = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

interface Props {
  message: MessageState;
  jid: string;
  group: boolean;
  onRetry: (id: string) => void;
  onQuote: (m: ChatMessage) => void;
  notify: (msg: string) => void;
}

function MessageBubbleImpl({ message, jid, group, onRetry, onQuote, notify }: Props) {
  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null);
  const [selectOpen, setSelectOpen] = useState(false);
  const { insertMention } = useCtx();
  const raw = (message.metadata.custom as { chat?: ChatMessage }).chat;
  if (!raw) return null;
  const chat = raw;
  const mine = chat.meta.mine;
  const retracted = chat.meta.retracted;
  const showActions = !retracted;

  const mineReactions = (chat.reactions ?? [])
    .filter((r) => r.userIds.includes(ME._id))
    .map((r) => r.emoji);

  const toggleReaction = (emoji: string) => {
    const next = mineReactions.includes(emoji)
      ? mineReactions.filter((e) => e !== emoji)
      : [...mineReactions, emoji];
    XmppService.react(jid, String(chat._id), next).catch((e) => notify(String(e)));
  };

  const copy = () => {
    void Clipboard.setStringAsync(chat.text);
  };

  const retract = () => {
    XmppService.retractMessage(jid, String(chat._id)).catch((e) => notify(String(e)));
  };

  let body: ReactNode;
  if (retracted) {
    body = <Text style={styles.retracted}>{chat.text}</Text>;
  } else if (chat.image) {
    body = <Image source={{ uri: chat.image }} style={styles.image} resizeMode="cover" />;
  } else if (chat.audio) {
    body = <AudioBubbleForMessage message={chat} />;
  } else {
    body = <MessageBody message={chat} />;
  }

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowIncoming]}>
      {!mine ? (
        <View style={styles.avatarSlot}>
          <Avatar jid={chat.realJid ?? chat.user._id} name={chat.user.name} size={30} />
        </View>
      ) : null}
      <View style={[styles.bubbleWrap, mine ? styles.bubbleWrapMine : styles.bubbleWrapIncoming]}>
        {group && !mine && chat.user.name ? (
          <Pressable
            onPress={() => insertMention(chat.user.name ?? '')}
            accessibilityRole="button"
            accessibilityLabel={`Mencionar ${chat.user.name}`}
          >
            <Text style={styles.username}>{chat.user.name}</Text>
          </Pressable>
        ) : null}
        {chat.replyMessage ? (
          <View style={styles.reply}>
            <Text style={styles.replyText} numberOfLines={2}>{chat.replyMessage.text}</Text>
          </View>
        ) : null}
        <Pressable
          style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleIncoming]}
          onLongPress={() => setSelectOpen(true)}
          accessibilityHint="Mantén pulsado para seleccionar texto"
        >
          {body}
          {chat.meta.extras ? (
            <MessageExtras jid={jid} message={chat} onRetry={onRetry} />
          ) : null}
          <Text style={[styles.time, mine ? styles.timeMine : styles.timeIncoming]}>
            {formatTime(chat.createdAt)}
          </Text>
        </Pressable>
        {chat.reactions && chat.reactions.length > 0 ? (
          <View style={[styles.reactions, mine ? styles.reactionsMine : styles.reactionsIncoming]}>
            {chat.reactions.map((r) => (
              <Pressable
                key={r.emoji}
                style={[styles.reactionChip, r.userIds.includes(ME._id) && styles.reactionChipMine]}
                onPress={() => toggleReaction(r.emoji)}
                accessibilityRole="button"
                accessibilityLabel={`Reacción ${r.emoji}`}
              >
                <Text style={styles.reactionEmoji}>{r.emoji}</Text>
                <Text style={styles.reactionCount}>{r.userIds.length}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      {showActions ? (
        <Pressable
          style={styles.actionsBtn}
          onPress={() => setMenuFor(chat)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Acciones del mensaje"
        >
          <Ionicons name="ellipsis-horizontal" size={16} color={Colors.textDim} />
        </Pressable>
      ) : null}

      <Modal
        visible={menuFor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuFor(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setMenuFor(null)}>
          <View style={styles.menu} onStartShouldSetResponder={() => true}>
            <Pressable style={styles.menuItem} onPress={() => { const m = menuFor; setMenuFor(null); if (m) onQuote(m); }}>
              <Ionicons name="return-down-back" size={18} color={Colors.primary} />
              <Text style={styles.menuLabel}>Responder</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { setMenuFor(null); copy(); }}>
              <Ionicons name="copy-outline" size={18} color={Colors.primary} />
              <Text style={styles.menuLabel}>Copiar</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { setMenuFor(null); setSelectOpen(true); }}>
              <Ionicons name="text-outline" size={18} color={Colors.primary} />
              <Text style={styles.menuLabel}>Seleccionar texto</Text>
            </Pressable>
            {menuFor?.meta.mine && !menuFor.meta.retracted ? (
              <Pressable
                style={[styles.menuItem, styles.menuItemDestructive]}
                onPress={() => { setMenuFor(null); retract(); }}
              >
                <Ionicons name="trash-outline" size={18} color={Colors.error} />
                <Text style={[styles.menuLabel, styles.menuLabelDestructive]}>Eliminar</Text>
              </Pressable>
            ) : null}
            <View style={styles.menuReact}>
              {QUICK_REACTIONS.map((emoji) => (
                <Pressable
                  key={emoji}
                  style={[styles.reactionBtn, mineReactions.includes(emoji) && styles.reactionBtnMine]}
                  onPress={() => { setMenuFor(null); toggleReaction(emoji); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Reaccionar ${emoji}`}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Pressable>
      </Modal>

      <Modal
        visible={selectOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectOpen(false)}
      >
        <View style={styles.selectBackdrop}>
          <View style={styles.selectCard}>
            <Text style={styles.selectTitle}>Mensaje</Text>
            <TextInput
              multiline
              value={chat.text}
              onChangeText={() => {}}
              showSoftInputOnFocus={false}
              selectionColor={Colors.primary}
              contextMenuHidden={false}
              style={styles.selectInput}
            />
            <View style={styles.selectActions}>
              <Pressable style={styles.selectBtn} onPress={() => { void Clipboard.setStringAsync(chat.text); }}>
                <Text style={styles.selectBtnText}>Copiar todo</Text>
              </Pressable>
              <Pressable style={styles.selectBtn} onPress={() => setSelectOpen(false)}>
                <Text style={styles.selectBtnText}>Cerrar</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export const MessageBubble = memo(MessageBubbleImpl, (a, b) =>
  a.message === b.message &&
  a.jid === b.jid &&
  a.group === b.group &&
  a.onRetry === b.onRetry &&
  a.onQuote === b.onQuote &&
  a.notify === b.notify,
);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingVertical: 4 },
  rowMine: { justifyContent: 'flex-end' },
  rowIncoming: { justifyContent: 'flex-start' },
  avatarSlot: { marginRight: 6, alignSelf: 'flex-end', paddingBottom: 2 },
  bubbleWrap: { maxWidth: '82%' },
  bubbleWrapMine: { alignItems: 'flex-end' },
  bubbleWrapIncoming: { alignItems: 'flex-start' },
  username: { color: Colors.primary, fontSize: 12, fontWeight: '600', marginBottom: 2 },
  reply: {
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
    paddingLeft: 8,
    marginBottom: 4,
  },
  replyText: { color: Colors.textDim, fontSize: 12, fontStyle: 'italic' },
  bubble: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleMine: { backgroundColor: Colors.userBubble },
  bubbleIncoming: { backgroundColor: Colors.assistantBubble, borderWidth: 1, borderColor: Colors.assistantBubbleBorder },
  time: { fontSize: 10, marginTop: 4 },
  timeMine: { color: Colors.userBubbleText, opacity: 0.7, alignSelf: 'flex-end' },
  timeIncoming: { color: Colors.textDim, alignSelf: 'flex-start' },
  retracted: { color: Colors.textDim, fontSize: 15, fontStyle: 'italic' },
  image: { width: 220, height: 220, borderRadius: 12 },
  reactions: {
    position: 'absolute',
    bottom: -12,
    flexDirection: 'row',
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.surfaceBorder,
    zIndex: 2,
  },
  reactionsMine: { right: 10 },
  reactionsIncoming: { left: 10 },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
    borderRadius: 10,
  },
  reactionChipMine: { backgroundColor: 'rgba(79,195,247,0.18)' },
  reactionEmoji: { fontSize: 13 },
  reactionCount: { color: Colors.textDim, fontSize: 11 },
  actionsBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  menu: { backgroundColor: Colors.surface, borderRadius: 14, padding: 8, minWidth: 220 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8 },
  menuItemDestructive: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.surfaceBorder, marginTop: 4 },
  menuLabel: { color: Colors.text, fontSize: 15 },
  menuLabelDestructive: { color: Colors.error },
  menuReact: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.surfaceBorder, marginTop: 4 },
  reactionBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.background },
  reactionBtnMine: { backgroundColor: Colors.primary, borderWidth: 1, borderColor: Colors.primary },
  selectBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  selectCard: { backgroundColor: Colors.surface, borderRadius: 14, padding: 16, gap: 12 },
  selectTitle: { color: Colors.textDim, fontSize: 13, fontWeight: '600' },
  selectInput: {
    color: Colors.text,
    fontSize: 15,
    lineHeight: 22,
    maxHeight: 320,
    minHeight: 120,
    backgroundColor: Colors.inputBackground,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: 12,
    textAlignVertical: 'top',
  },
  selectActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  selectBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: Colors.primary },
  selectBtnText: { color: Colors.background, fontWeight: '700', fontSize: 14 },
});
