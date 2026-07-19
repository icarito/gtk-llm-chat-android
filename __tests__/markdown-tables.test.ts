import { splitMarkdownTables } from '@/xmpp/markdownTables';

describe('Markdown tables', () => {
  it('preserves prose and parses rows and alignment', () => {
    const blocks = splitMarkdownTables(
      'Antes\n\n| Métrica | Valor |\n| :-- | --: |\n| Entrada | 1.6k |\n\nDespués',
    );
    expect(blocks).toEqual([
      { type: 'text', value: 'Antes' },
      {
        type: 'table',
        value: {
          headers: ['Métrica', 'Valor'],
          rows: [['Entrada', '1.6k']],
          align: ['left', 'right'],
        },
      },
      { type: 'text', value: 'Después' },
    ]);
  });

  it('keeps escaped pipes inside a cell', () => {
    const blocks = splitMarkdownTables('| A |\n| - |\n| x \\| y |');
    expect(blocks[0]).toMatchObject({
      type: 'table',
      value: { rows: [['x | y']] },
    });
  });
});
