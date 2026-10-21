import { memo, type ReactNode } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { Colors } from '@/constants/theme';
import { openExternalUrl } from '@/platform/openExternalUrl';

type Seg =
  | { t: 'text'; s: string }
  | { t: 'code'; s: string }
  | { t: 'bold'; s: string }
  | { t: 'italic'; s: string }
  | { t: 'strike'; s: string }
  | { t: 'link'; s: string; url: string };

const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/y;
const BOLD_RE = /\*\*([^*]+?)\*\*/y;
const ITALIC_RE = /\*([^*\n]+?)\*/y;
const STRIKE_RE = /~~([^~]+?)~~/y;
const URL_RE = /https?:\/\/[^\s<>"']+/y;

const MAX_DEPTH = 3;

/** Divide por spans de código ```...```; los índices pares son prosa. */
function splitCodeSpans(text: string): string[] {
  const out = text.split(/`+/);
  return out;
}

function parseInline(text: string): Seg[] {
  const segs: Seg[] = [];
  let i = 0;
  let textBuf = '';
  const flush = () => {
    if (textBuf) {
      segs.push({ t: 'text', s: textBuf });
      textBuf = '';
    }
  };
  while (i < text.length) {
    LINK_RE.lastIndex = i;
    const link = LINK_RE.exec(text);
    if (link && link.index === i) {
      flush();
      segs.push({ t: 'link', s: link[1]!, url: link[2]! });
      i = LINK_RE.lastIndex;
      continue;
    }
    BOLD_RE.lastIndex = i;
    const bold = BOLD_RE.exec(text);
    if (bold && bold.index === i) {
      flush();
      segs.push({ t: 'bold', s: bold[1]! });
      i = BOLD_RE.lastIndex;
      continue;
    }
    ITALIC_RE.lastIndex = i;
    const italic = ITALIC_RE.exec(text);
    if (italic && italic.index === i) {
      flush();
      segs.push({ t: 'italic', s: italic[1]! });
      i = ITALIC_RE.lastIndex;
      continue;
    }
    STRIKE_RE.lastIndex = i;
    const strike = STRIKE_RE.exec(text);
    if (strike && strike.index === i) {
      flush();
      segs.push({ t: 'strike', s: strike[1]! });
      i = STRIKE_RE.lastIndex;
      continue;
    }
    URL_RE.lastIndex = i;
    const url = URL_RE.exec(text);
    if (url && url.index === i) {
      flush();
      segs.push({ t: 'link', s: url[0]!, url: url[0]! });
      i = URL_RE.lastIndex;
      continue;
    }
    textBuf += text[i]!;
    i += 1;
  }
  flush();
  return segs;
}

function inlineTokens(tokens: Seg[], style?: StyleProp<TextStyle>, depth = 0): ReactNode[] {
  return tokens.map((seg, index) => {
    switch (seg.t) {
      case 'text':
        return (
          <Text key={index} style={style}>{seg.s}</Text>
        );
      case 'code':
        return (
          <Text key={index} style={[style, styles.code]}>{seg.s}</Text>
        );
      case 'link':
        return (
          <Text
            key={index}
            style={[style, styles.link]}
            onPress={() => { void openExternalUrl(seg.url); }}
          >
            {seg.s}
          </Text>
        );
      case 'bold':
        return (
          <Text key={index} style={[style, styles.bold]}>
            {depth < MAX_DEPTH ? inlineTokens(parseInline(seg.s), style, depth + 1) : seg.s}
          </Text>
        );
      case 'italic':
        return (
          <Text key={index} style={[style, styles.italic]}>
            {depth < MAX_DEPTH ? inlineTokens(parseInline(seg.s), style, depth + 1) : seg.s}
          </Text>
        );
      case 'strike':
        return (
          <Text key={index} style={[style, styles.strike]}>
            {depth < MAX_DEPTH ? inlineTokens(parseInline(seg.s), style, depth + 1) : seg.s}
          </Text>
        );
      default: {
        const never: never = seg;
        return never;
      }
    }
  });
}

interface MarkdownInlineProps {
  text: string;
  style?: StyleProp<TextStyle>;
}

function MarkdownInlineImpl({ text, style }: MarkdownInlineProps) {
  const chunks = splitCodeSpans(text);
  const nodes: ReactNode[] = [];
  chunks.forEach((chunk, index) => {
    if (index % 2 === 1) {
      nodes.push(<Text key={index} style={[style, styles.code]}>{chunk}</Text>);
    } else if (chunk) {
      nodes.push(<Text key={index} style={style}>{inlineTokens(parseInline(chunk), style)}</Text>);
    }
  });
  return <Text style={style}>{nodes}</Text>;
}

export const MarkdownInline = memo(MarkdownInlineImpl);

const styles = StyleSheet.create({
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  code: {
    fontFamily: 'monospace',
    fontSize: 13,
    color: Colors.primary,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  link: { color: Colors.primary, textDecorationLine: 'underline' },
});
