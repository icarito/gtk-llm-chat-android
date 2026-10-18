import { memo, useEffect, useMemo, useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react-native';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { Colors } from '@/constants/theme';
import { useRoom } from '@/xmpp/XmppContext';
import { XmppService } from '@/xmpp/XmppService';
import { suggest, type SuggestSources } from './autocomplete';

/**
 * Sugerencias sobre el composer: `/` lista los comandos ad-hoc del contacto
 * (se piden una vez, al teclear la primera `/`), `@` los ocupantes de la sala.
 * El cursor se asume al final del texto (el caso de escribir de corrido).
 */
function SuggestionBarImpl({ jid }: { jid: string }) {
  const text = useAuiState((s) => s.composer.text);
  const aui = useAui();
  const room = useRoom(jid);
  const wantsCommands = !room && text.startsWith('/');
  const [commands, setCommands] = useState<SuggestSources['commands'] | null>(null);

  useEffect(() => {
    if (!wantsCommands || commands) return;
    let alive = true;
    XmppService.listAdhocCommands(jid)
      .then((list) => { if (alive) setCommands(list.map((c) => ({ name: c.name }))); })
      .catch(() => { if (alive) setCommands([]); });
    return () => { alive = false; };
  }, [jid, wantsCommands, commands]);

  const participants = useMemo(
    () => (room ? Object.keys(room.occupants).filter((n) => n !== room.nick) : []),
    [room],
  );
  const items = useMemo(
    () => suggest(text, text.length, { commands: commands ?? [], participants }),
    [text, commands, participants],
  );
  if (!items.length) return null;

  return (
    <ScrollView horizontal keyboardShouldPersistTaps="always" style={styles.bar} contentContainerStyle={styles.content}>
      {items.map((s) => (
        <Pressable
          key={s.label}
          style={styles.chip}
          onPress={() => aui.composer.setText(text.slice(0, s.replaceStart) + s.insert + text.slice(s.replaceEnd))}
        >
          <Text style={styles.label}>{s.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export const SuggestionBar = memo(SuggestionBarImpl);

const styles = StyleSheet.create({
  bar: { maxHeight: 44, backgroundColor: Colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.surfaceBorder },
  content: { alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder },
  label: { color: Colors.primary, fontSize: 14 },
});
