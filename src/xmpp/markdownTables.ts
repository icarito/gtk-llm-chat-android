export interface MarkdownTable {
  headers: string[];
  rows: string[][];
  align: Array<'left' | 'center' | 'right'>;
}

export type MarkdownBlock =
  | { type: 'text'; value: string }
  | { type: 'table'; value: MarkdownTable };

const DELIMITER_CELL_RE = /^:?-{1,}:?$/;

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const result: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '|') {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function isDelimiter(line: string): boolean {
  const parsed = cells(line);
  return parsed.length > 0 && parsed.every((cell) => DELIMITER_CELL_RE.test(cell));
}

export function splitMarkdownTables(markdown: string): MarkdownBlock[] {
  const lines = markdown.split('\n');
  const blocks: MarkdownBlock[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    const value = prose.join('\n').trim();
    if (value) blocks.push({ type: 'text', value });
    prose = [];
  };

  for (let index = 0; index < lines.length;) {
    if (index + 1 >= lines.length || !lines[index]!.includes('|') || !isDelimiter(lines[index + 1]!)) {
      prose.push(lines[index]!);
      index += 1;
      continue;
    }
    flushProse();
    const headers = cells(lines[index]!);
    const delimiters = cells(lines[index + 1]!);
    const align = delimiters.map((cell) => (
      cell.startsWith(':') && cell.endsWith(':') ? 'center'
        : cell.endsWith(':') ? 'right' : 'left'
    ));
    index += 2;
    const rows: string[][] = [];
    while (index < lines.length && lines[index]!.trim() && lines[index]!.includes('|')) {
      const row = cells(lines[index]!).slice(0, headers.length);
      while (row.length < headers.length) row.push('');
      rows.push(row);
      index += 1;
    }
    blocks.push({ type: 'table', value: { headers, rows, align } });
  }
  flushProse();
  return blocks.length ? blocks : [{ type: 'text', value: markdown }];
}
