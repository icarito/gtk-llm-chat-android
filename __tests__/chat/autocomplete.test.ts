import { suggest } from '@/chat/autocomplete';

const sources = {
  commands: [{ name: 'status', description: 'Estado' }, { name: '/new' }, { name: 'restart' }],
  participants: ['Ana', 'bob', 'Ana', 'Mariana'],
};

describe('suggest', () => {
  it('sugiere comandos por prefijo antes que por subcadena', () => {
    const s = suggest('/st', 3, sources);
    expect(s.map((x) => x.label)).toEqual(['/status', '/restart']);
    expect(s[0]).toMatchObject({ insert: '/status ', replaceStart: 0, replaceEnd: 3, hint: 'Estado' });
  });

  it('sólo hay comandos al inicio del mensaje', () => {
    expect(suggest('hola /st', 8, sources)).toEqual([]);
  });

  it('sugiere participantes sin duplicados, en cualquier posición', () => {
    const s = suggest('hola @an', 8, sources);
    expect(s.map((x) => x.label)).toEqual(['@Ana', '@Mariana']);
    expect(s[0]).toMatchObject({ replaceStart: 5, replaceEnd: 8 });
  });

  it('@ solo lista a todos y el cursor intermedio sustituye la palabra entera', () => {
    expect(suggest('@', 1, sources)).toHaveLength(3);
    expect(suggest('@bxx', 2, sources)[0]).toMatchObject({ label: '@bob', replaceEnd: 4 });
  });

  it('sin token o texto normal no devuelve nada', () => {
    expect(suggest('hola ', 5, sources)).toEqual([]);
    expect(suggest('hola', 4, sources)).toEqual([]);
    expect(suggest('', 0, sources)).toEqual([]);
  });
});
