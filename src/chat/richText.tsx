import { memo, useMemo } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { clamp, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { MessageText, type MessageTextProps } from '@kesha-antonov/react-native-chat';
import { Colors } from '@/constants/theme';
import { splitMarkdownTables, type MarkdownTable } from '@/xmpp/markdownTables';
import type { ChatMessage } from './toIMessage';

type Props = MessageTextProps<ChatMessage>;

const CODE_FENCE_RE = /```([^\n`]*)\n?([\s\S]*?)```/g;

type Part = { type: 'text'; value: string } | { type: 'code'; value: string; language?: string };

export function splitCodeFences(content: string): Part[] {
  const parts: Part[] = [];
  CODE_FENCE_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_FENCE_RE.exec(content)) !== null) {
    if (match.index > cursor) parts.push({ type: 'text', value: content.slice(cursor, match.index) });
    const language = (match[1] || '').trim().split(/\s+/)[0];
    parts.push({
      type: 'code',
      value: (match[2] || '').replace(/\n$/, ''),
      ...(language ? { language } : {}),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) parts.push({ type: 'text', value: content.slice(cursor) });
  return parts.length ? parts : [{ type: 'text', value: content }];
}

// Ancho de borde/padding por celda (borderRightWidth + paddingHorizontal*2);
// tiene que coincidir con styles.tableCell: el ancho total de la tabla se
// calcula, no se mide con onLayout.
const TABLE_CELL_CHROME = 19;
// Fracción del ancho de pantalla que ocupa una burbuja y su padding propio.
const BUBBLE_WIDTH_FRACTION = 0.78;
const BUBBLE_HORIZONTAL_PADDING = 24;

function MarkdownTableView({ table }: { table: MarkdownTable }) {
  const widths = table.headers.map((header, column) => Math.min(
    260,
    Math.max(100, ...[header, ...table.rows.map((row) => row[column] ?? '')]
      .map((cell) => cell.length * 8 + 24)),
  ));
  const tableWidth = widths.reduce((sum, w) => sum + w + TABLE_CELL_CHROME, 0);

  // Un ScrollView horizontal dentro de la lista invertida rompía la altura de
  // la celda en Android (ver AGENTS.md): Pan + translateX en su lugar, con el
  // viewport calculado (no medido: el contenedor no puede medirse a sí mismo
  // cuando su único hijo fija su ancho natural).
  const { width: windowWidth } = useWindowDimensions();
  const viewportWidth = windowWidth * BUBBLE_WIDTH_FRACTION - BUBBLE_HORIZONTAL_PADDING;
  const translateX = useSharedValue(0);
  const maxScroll = Math.max(0, tableWidth - viewportWidth);
  const pan = useMemo(() => Gesture.Pan()
    .enabled(maxScroll > 0)
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onUpdate((event) => {
      'worklet';
      translateX.value = clamp(event.translationX, -maxScroll, 0);
    }), [maxScroll, translateX]);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));

  return (
    <View style={[styles.tableScroll, { width: Math.min(tableWidth, viewportWidth) }]}>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.table, { width: tableWidth }, animatedStyle]}>
          {[table.headers, ...table.rows].map((row, rowIndex) => (
            <View key={`row-${rowIndex}`} style={styles.tableRow}>
              {widths.map((width, column) => (
                <Text
                  key={`cell-${column}`}
                  style={[
                    styles.tableCell,
                    rowIndex === 0 && styles.tableHeader,
                    { width, textAlign: table.align[column] ?? 'left' },
                  ]}
                >
                  {row[column] ?? ''}
                </Text>
              ))}
            </View>
          ))}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHeader}>
        <Text style={styles.codeLanguage} numberOfLines={1}>{language || 'code'}</Text>
        <TouchableOpacity
          style={styles.codeCopyButton}
          onPress={() => Clipboard.setStringAsync(code)}
          accessibilityRole="button"
          accessibilityLabel="Copiar código"
        >
          <Ionicons name="copy-outline" size={16} color={Colors.text} />
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.codeText}>{code || ' '}</Text>
      </ScrollView>
    </View>
  );
}

/** Texto con bloques ``` y tablas GFM; la prosa intermedia sigue pasando por el markdown de la lib. */
function RichBodyImpl(props: Props) {
  const { currentMessage } = props;
  return (
    <View style={styles.body}>
      {splitCodeFences(currentMessage.text).map((part, index) => {
        if (part.type === 'code') {
          return <CodeBlock key={`code-${index}`} code={part.value} language={part.language} />;
        }
        if (!part.value.trim()) return null;
        return splitMarkdownTables(part.value).map((block, blockIndex) => (
          block.type === 'table' ? (
            <MarkdownTableView key={`table-${index}-${blockIndex}`} table={block.value} />
          ) : (
            <MessageText
              key={`text-${index}-${blockIndex}`}
              {...props}
              currentMessage={{ ...currentMessage, text: block.value }}
            />
          )
        ));
      })}
    </View>
  );
}

// Se re-renderiza sólo si cambió el mensaje: el split/regex corre una vez por versión.
const RichBody = memo(
  RichBodyImpl,
  (a, b) => a.currentMessage === b.currentMessage && a.position === b.position,
);

/**
 * renderMessageText de la lib. Ruta rápida: texto normal -> markdown nativo de
 * la lib. Sólo código/tablas usan RichBody; la salida de herramientas va en un
 * scroll vertical acotado.
 */
export function renderMessageText(props: Props) {
  const { meta } = props.currentMessage;
  const body = meta.rich ? <RichBody {...props} /> : <MessageText {...props} />;
  if (!meta.tool) return body;
  return (
    <ScrollView style={styles.toolScroll} nestedScrollEnabled showsVerticalScrollIndicator>
      {body}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { gap: 6 },
  toolScroll: { maxHeight: 180 },
  tableScroll: { alignSelf: 'flex-start', maxWidth: '100%', overflow: 'hidden' },
  table: { borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: 6, overflow: 'hidden' },
  tableRow: { flexDirection: 'row' },
  tableCell: {
    color: Colors.text,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  tableHeader: { fontWeight: '700', backgroundColor: 'rgba(255,255,255,0.08)' },
  codeBlock: {
    minWidth: 220,
    overflow: 'hidden',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    backgroundColor: 'rgba(0,0,0,0.16)',
  },
  codeHeader: {
    minHeight: 30,
    paddingLeft: 8,
    paddingRight: 4,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  codeLanguage: { flex: 1, color: Colors.textDim, fontSize: 12, fontWeight: '600' },
  codeCopyButton: { width: 30, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  codeText: {
    paddingHorizontal: 9,
    paddingVertical: 8,
    color: Colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 18,
  },
});
