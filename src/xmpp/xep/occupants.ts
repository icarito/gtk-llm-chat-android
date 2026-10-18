export interface OccupantInput {
  nick: string;
  realJid?: string;
  role: string;
  affiliation: string;
  isAgent: boolean;
}

export interface OccupantGroup {
  key: string;
  nicks: string[];
  devices: number;
  role: string;
  affiliation: string;
  isAgent: boolean;
}

export interface GroupedOccupants {
  agents: OccupantGroup[];
  people: OccupantGroup[];
}

const AFFILIATION_RANK: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  none: 1,
  outcast: 0,
};

const ROLE_RANK: Record<string, number> = {
  moderator: 3,
  participant: 2,
  visitor: 1,
  none: 0,
};

function bareJid(jid: string): string {
  const slash = jid.indexOf('/');
  return slash < 0 ? jid : jid.slice(0, slash);
}

function affiliationRank(affiliation: string): number {
  return AFFILIATION_RANK[affiliation] ?? -1;
}

function roleRank(role: string): number {
  return ROLE_RANK[role] ?? -1;
}

/**
 * Agrupa ocupantes de una sala por su JID real bare, fusionando varios
 * recursos/nick de la misma persona en un grupo con `devices` (XEP-0045 en
 * salas no anónimas). En salas anónimas no hay `realJid`: cada nick es su
 * propio grupo y nunca se infiere una identidad por nick.
 */
export function groupOccupants(occupants: OccupantInput[]): GroupedOccupants {
  const groups = new Map<string, OccupantGroup>();
  const groupAffiliationRank = new Map<string, number>();
  const groupRoleRank = new Map<string, number>();

  for (const occupant of occupants) {
    if (!occupant.nick) continue;

    const realJid = occupant.realJid ? bareJid(occupant.realJid) : '';
    const key = realJid || `nick:${occupant.nick}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        nicks: [],
        devices: 0,
        role: '',
        affiliation: '',
        isAgent: false,
      };
      groups.set(key, group);
      groupAffiliationRank.set(key, -1);
      groupRoleRank.set(key, -1);
    }

    group.nicks.push(occupant.nick);
    group.isAgent = group.isAgent || occupant.isAgent;

    const affRank = affiliationRank(occupant.affiliation);
    if (affRank > (groupAffiliationRank.get(key) ?? -1)) {
      group.affiliation = occupant.affiliation;
      groupAffiliationRank.set(key, affRank);
    }

    const role = roleRank(occupant.role);
    if (role > (groupRoleRank.get(key) ?? -1)) {
      group.role = occupant.role;
      groupRoleRank.set(key, role);
    }
  }

  const agents: OccupantGroup[] = [];
  const people: OccupantGroup[] = [];
  for (const group of groups.values()) {
    group.devices = group.nicks.length;
    if (group.isAgent) agents.push(group);
    else people.push(group);
  }

  return { agents, people };
}

export function devicesLabel(devices: number): string {
  if (devices <= 0) return '';
  return devices === 1 ? '1 dispositivo' : `${devices} dispositivos`;
}
