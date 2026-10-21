import { decideScrollAnchor, isAtBottom, type ScrollMemoryEntry } from '@/chat/scrollAnchor';

const entry = (o: Partial<ScrollMemoryEntry> = {}): ScrollMemoryEntry => ({
  offset: 0,
  contentHeight: 1000,
  viewportHeight: 500,
  atBottom: false,
  ...o,
});

describe('isAtBottom', () => {
  it('contenido más corto que el viewport siempre está al final', () => {
    expect(isAtBottom(0, 300, 500)).toBe(true);
  });

  it('detecta el final con margen', () => {
    expect(isAtBottom(500, 1000, 500)).toBe(true);
    expect(isAtBottom(495, 1000, 500)).toBe(true);
    expect(isAtBottom(400, 1000, 500)).toBe(false);
  });
});

describe('decideScrollAnchor', () => {
  it('sin memoria → al final (primer ingreso)', () => {
    expect(decideScrollAnchor(undefined, 1000)).toEqual({ kind: 'bottom' });
  });

  it('si estaba al final → al final', () => {
    expect(decideScrollAnchor(entry({ atBottom: true, offset: 500 }), 1000)).toEqual({ kind: 'bottom' });
  });

  it('si había subido y el offset cabe → restaura', () => {
    expect(decideScrollAnchor(entry({ offset: 200, contentHeight: 1000, viewportHeight: 500 }), 1000))
      .toEqual({ kind: 'offset', offset: 200 });
  });

  it('offset fuera del contenido actual → al final (evita el hueco vacío)', () => {
    expect(decideScrollAnchor(entry({ offset: 900, viewportHeight: 500 }), 600)).toEqual({ kind: 'bottom' });
  });

  it('contenido aún sin medir (0) → al final', () => {
    expect(decideScrollAnchor(entry({ offset: 100 }), 0)).toEqual({ kind: 'bottom' });
  });

  it('offset negativo → al final', () => {
    expect(decideScrollAnchor(entry({ offset: -10 }), 1000)).toEqual({ kind: 'bottom' });
  });
});
