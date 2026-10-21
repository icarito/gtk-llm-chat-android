/** Moderación y configuración de salas (XEP-0045 admin/owner) más invitar y asunto. */
import type { Element } from '@xmpp/xml';
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
import type { DataForm, FormField } from '@/types/xmpp';

const NS_DATA_FORMS = 'jabber:x:data';
const NS_MUC_OWNER = 'http://jabber.org/protocol/muc#owner';

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

/** Parsea el form de config XEP-0004 completo (label/desc/options/required), no sólo var/type/values. */
function parseConfigFormFull(iq: Element): DataForm {
  const x = iq.getChild('query', NS_MUC_OWNER)?.getChild('x', NS_DATA_FORMS);
  if (!x) return { type: 'form', fields: [] };

  const form: DataForm = {
    type: (x.attrs.type as DataForm['type']) ?? 'form',
    fields: [],
  };
  if (x.attrs.title) form.title = x.attrs.title;
  const instructions = x.getChildren('instructions').map((i) => i.text());
  if (instructions.length > 0) form.instructions = instructions;

  for (const f of x.getChildren('field')) {
    const options = f.getChildren('option').map((o) => ({
      label: o.attrs.label ?? o.getChild('value')?.text() ?? '',
      value: o.getChild('value')?.text() ?? '',
    }));
    const rawValues = f.getChildren('value').map((v) => v.text());
    const field: FormField = {
      var: f.attrs.var ?? '',
      type: (f.attrs.type as FormField['type']) || undefined,
      label: f.attrs.label,
      desc: f.getChild('desc')?.text(),
      required: f.getChild('required') !== undefined,
      options: options.length > 0 ? options : undefined,
    };
    if (rawValues.length === 1) field.value = rawValues[0];
    else if (rawValues.length > 1) field.value = rawValues;
    form.fields.push(field);
  }

  return form;
}

/** Form completo de configuración de la sala (owner). Falla con IQ de error si no somos owner. */
export async function getRoomConfigForm(room: string): Promise<DataForm> {
  return parseConfigFormFull(await client().iqCaller.request(buildConfigGet(room), 15000));
}
