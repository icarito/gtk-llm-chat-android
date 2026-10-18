/**
 * Autocompletado del composer: `/comando` (sólo al inicio del texto) y
 * `@participante` (en cualquier palabra). Función pura: el composer pasa el
 * texto y el cursor, y aplica `replaceStart..replaceEnd` con `insert`.
 */
export interface Suggestion {
  kind: 'command' | 'participant';
  /** Texto a mostrar (con el prefijo `/` o `@`). */
  label: string;
  /** Texto que sustituye al token (incluye el espacio final). */
  insert: string;
  /** Rango [replaceStart, replaceEnd) del token a sustituir. */
  replaceStart: number;
  replaceEnd: number;
  /** Descripción opcional del comando. */
  hint?: string;
}

export interface SuggestSources {
  commands: { name: string; description?: string }[];
  participants: string[];
}

const MAX_SUGGESTIONS = 8;

function rank(candidate: string, query: string): number {
  const c = candidate.toLowerCase();
  if (c.startsWith(query)) return 0;
  return c.includes(query) ? 1 : -1;
}

export function suggest(input: string, cursor: number, sources: SuggestSources): Suggestion[] {
  const pos = Math.max(0, Math.min(cursor, input.length));
  // Token = desde el último espacio/salto anterior al cursor hasta el cursor.
  const start = Math.max(input.lastIndexOf(' ', pos - 1), input.lastIndexOf('\n', pos - 1)) + 1;
  const token = input.slice(start, pos);
  if (!token) return [];
  // Si el cursor está en mitad de una palabra, se sustituye también el resto.
  const rest = /^\S*/.exec(input.slice(pos))?.[0] ?? '';
  const end = pos + rest.length;

  let kind: Suggestion['kind'];
  if (token[0] === '/' && start === 0) kind = 'command';
  else if (token[0] === '@') kind = 'participant';
  else return [];

  const query = token.slice(1).toLowerCase();
  const prefix = kind === 'command' ? '/' : '@';
  const items = kind === 'command'
    ? sources.commands.map((c) => ({ name: c.name.replace(/^\//, ''), hint: c.description }))
    : [...new Set(sources.participants)].map((name) => ({ name, hint: undefined }));

  return items
    .map((item) => ({ item, r: query ? rank(item.name, query) : 0 }))
    .filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r || a.item.name.localeCompare(b.item.name))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ item }) => ({
      kind,
      label: prefix + item.name,
      insert: `${prefix}${item.name} `,
      replaceStart: start,
      replaceEnd: end,
      ...(item.hint ? { hint: item.hint } : {}),
    }));
}
