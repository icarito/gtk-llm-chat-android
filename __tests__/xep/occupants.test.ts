import {
  devicesLabel,
  groupOccupants,
  type OccupantInput,
} from '@/xmpp/xep/occupants';

function occupant(overrides: Partial<OccupantInput> & { nick: string }): OccupantInput {
  return {
    role: 'participant',
    affiliation: 'none',
    isAgent: false,
    ...overrides,
  };
}

describe('occupants', () => {
  it('agrupa dos nicks del mismo JID real como 2 dispositivos', () => {
    const grouped = groupOccupants([
      occupant({
        nick: 'ana',
        realJid: 'ana@example.org/phone',
        role: 'participant',
        affiliation: 'member',
      }),
      occupant({
        nick: 'ana-portatil',
        realJid: 'ana@example.org/laptop',
        role: 'moderator',
        affiliation: 'admin',
        isAgent: true,
      }),
    ]);

    expect(grouped.agents).toHaveLength(1);
    expect(grouped.people).toHaveLength(0);
    expect(grouped.agents[0]).toEqual({
      key: 'ana@example.org',
      nicks: ['ana', 'ana-portatil'],
      devices: 2,
      role: 'moderator',
      affiliation: 'admin',
      isAgent: true,
    });
  });

  it('en sala anónima no agrupa: cada nick es un grupo propio', () => {
    const grouped = groupOccupants([
      occupant({ nick: 'ana', role: 'participant' }),
      occupant({ nick: 'leo', role: 'visitor' }),
    ]);

    expect(grouped.people).toHaveLength(2);
    expect(grouped.people.map((group) => group.key)).toEqual(['nick:ana', 'nick:leo']);
    expect(grouped.people.map((group) => group.devices)).toEqual([1, 1]);
  });

  it('separa agentes y personas conservando el orden de aparición', () => {
    const grouped = groupOccupants([
      occupant({ nick: 'leo', realJid: 'leo@example.org/x' }),
      occupant({ nick: 'bot', realJid: 'bot@example.org/phone', isAgent: true }),
      occupant({ nick: 'ana', realJid: 'ana@example.org/x' }),
    ]);

    expect(grouped.agents.map((group) => group.key)).toEqual(['bot@example.org']);
    expect(grouped.people.map((group) => group.key)).toEqual([
      'leo@example.org',
      'ana@example.org',
    ]);
  });

  it('etiqueta el número de dispositivos', () => {
    expect(devicesLabel(0)).toBe('');
    expect(devicesLabel(1)).toBe('1 dispositivo');
    expect(devicesLabel(3)).toBe('3 dispositivos');
  });
});
