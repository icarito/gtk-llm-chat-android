/** Moderación y configuración de salas (XEP-0045 admin/owner) más invitar y asunto. */
import type { ParsedConfigField, ConfigField, MucAffiliation, MucRole } from '@/xmpp/xep/muc';
import {
  buildBan,
  buildConfigGet,
  buildConfigSubmit,
  buildInvite,
  buildKick,
  buildSetAffiliation,
  buildSetRole,
  buildSetSubject,
  parseConfigForm,
} from '@/xmpp/xep/muc';
import { usableClient } from '@/xmpp/session';

function client() {
  const c = usableClient();
  if (!c) throw new Error('XMPP not connected');
  return c;
}

/** Cambia el rol de un ocupante (por nick). */
export async function setRole(room: string, nick: string, role: MucRole, reason?: string): Promise<void> {
  await client().iqCaller.request(buildSetRole(room, nick, role, reason), 15000);
}

/** Cambia la afiliación de un JID (bare real del usuario). */
export async function setAffiliation(room: string, jid: string, affiliation: MucAffiliation, reason?: string): Promise<void> {
  await client().iqCaller.request(buildSetAffiliation(room, jid, affiliation, reason), 15000);
}

export async function kick(room: string, nick: string, reason?: string): Promise<void> {
  await client().iqCaller.request(buildKick(room, nick, reason), 15000);
}

export async function ban(room: string, jid: string, reason?: string): Promise<void> {
  await client().iqCaller.request(buildBan(room, jid, reason), 15000);
}

export async function setSubject(room: string, subject: string): Promise<void> {
  await client().send(buildSetSubject(room, subject));
}

/** Invitación mediada por la sala (XEP-0045 §7.8). */
export async function invite(room: string, jid: string, reason?: string): Promise<void> {
  await client().send(buildInvite(room, jid, reason));
}

export async function getRoomConfig(room: string): Promise<ParsedConfigField[]> {
  return parseConfigForm(await client().iqCaller.request(buildConfigGet(room), 15000));
}

export async function submitRoomConfig(room: string, fields: ConfigField[]): Promise<void> {
  await client().iqCaller.request(buildConfigSubmit(room, fields), 15000);
}
