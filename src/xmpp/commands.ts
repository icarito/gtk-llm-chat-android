/** XEP-0050: comandos ad-hoc (incluido el elevated de sesión). */
import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import type { DataForm, XmppInlineCommand } from '@/types/xmpp';
import { buildFormElement, parseForm, parseSubmitForm } from '@/xmpp/xep-0004';
import { buildCommandExecuteStanza } from '@/xmpp/outbound-render';
import { COMMAND_NS, DISCO_ITEMS_NS } from '@/xmpp/ns';
import { usableClient } from '@/xmpp/session';

function noteText(command: Element): string {
  const notes = command.getChildren('note');
  const parts = notes.map((note) => note.text()).filter(Boolean);
  return parts.join('\n') || 'Command completed.';
}

/** Command result with both the human-readable note and, when the server
 *  attached one (xmpp-approval-unified-contract), the structured XEP-0004
 *  `type="result"` form as parsed var->value pairs. `fields` is `{}` when
 *  the server didn't attach a result form -- most ad-hoc commands don't. */
export type CommandResult = { text: string; fields: Record<string, string> };

export async function executeCommandWithFields(targetJid: string, node: string, form?: DataForm): Promise<CommandResult> {
  const client = usableClient();
  if (!client) {
    throw new Error('XMPP not connected');
  }

  const first = await client.iqCaller.request(
    buildCommandExecuteStanza(
      targetJid,
      node,
      `cmd-${Date.now().toString(36)}`,
    ),
    30000,
  );
  let command = first.getChild('command', COMMAND_NS);
  if (!command) throw new Error('Invalid command response');
  if (command.attrs.status === 'completed') return { text: noteText(command), fields: resultFields(command) };
  if (!form) throw new Error('Command requires a form submission');

  const sessionid = command.attrs.sessionid as string | undefined;
  if (!sessionid) throw new Error('Command did not return a session id');

  const second = await client.iqCaller.request(
    xml(
      'iq',
      { type: 'set', to: targetJid, id: `cmd-submit-${Date.now().toString(36)}` },
      xml('command', { xmlns: COMMAND_NS, node, sessionid, action: 'complete' }, buildFormElement(form)),
    ),
    30000,
  );
  command = second.getChild('command', COMMAND_NS);
  if (!command) throw new Error('Invalid command submit response');
  return { text: noteText(command), fields: resultFields(command) };
}

/** `parseSubmitForm` reads var/value pairs from any `jabber:x:data` child
 *  regardless of its `type` attribute (submit or result) -- the wire shape
 *  is identical, only the semantics differ. */
function resultFields(command: Element): Record<string, string> {
  const x = command.getChild('x', 'jabber:x:data');
  return x ? parseSubmitForm(x) : {};
}

export async function executeCommand(targetJid: string, node: string, form?: DataForm): Promise<string> {
  return (await executeCommandWithFields(targetJid, node, form)).text;
}

/** Primer paso de un comando genérico: ejecuta y, si el servidor lo pide, devuelve el form XEP-0004. */
export type AdhocCommandBegin =
  | { status: 'completed'; result: CommandResult }
  | { status: 'executing'; sessionid: string; node: string; name: string; form: DataForm };

export async function beginAdhocCommand(targetJid: string, node: string): Promise<AdhocCommandBegin> {
  const client = usableClient();
  if (!client) {
    throw new Error('XMPP not connected');
  }

  const first = await client.iqCaller.request(
    buildCommandExecuteStanza(
      targetJid,
      node,
      `cmd-${Date.now().toString(36)}`,
    ),
    30000,
  );
  const command = first.getChild('command', COMMAND_NS);
  if (!command) throw new Error('Invalid command response');
  if (command.attrs.status === 'completed') {
    return { status: 'completed', result: { text: noteText(command), fields: resultFields(command) } };
  }

  const sessionid = command.attrs.sessionid as string | undefined;
  if (!sessionid) throw new Error('Command did not return a session id');

  const x = command.getChild('x', 'jabber:x:data');
  const form = x ? parseForm(x) : undefined;
  if (!form) throw new Error('Command requires a form submission');

  return { status: 'executing', sessionid, node, name: (command.attrs.node as string | undefined) ?? node, form };
}

/** Envía el form XEP-0004 de un comando ad-hoc (fase `complete`). */
export async function submitAdhocCommand(
  targetJid: string,
  node: string,
  sessionid: string,
  form: DataForm,
): Promise<CommandResult> {
  const client = usableClient();
  if (!client) {
    throw new Error('XMPP not connected');
  }

  const second = await client.iqCaller.request(
    xml(
      'iq',
      { type: 'set', to: targetJid, id: `cmd-submit-${Date.now().toString(36)}` },
      xml('command', { xmlns: COMMAND_NS, node, sessionid, action: 'complete' }, buildFormElement(form)),
    ),
    30000,
  );
  const command = second.getChild('command', COMMAND_NS);
  if (!command) throw new Error('Invalid command submit response');
  return { text: noteText(command), fields: resultFields(command) };
}

export async function listAdhocCommands(targetJid: string): Promise<XmppInlineCommand[]> {
  const client = usableClient();
  if (!client) {
    throw new Error('XMPP not connected');
  }
  const result = await client.iqCaller.request(
    xml(
      'iq',
      { type: 'get', to: targetJid, id: `disco-items-${Date.now().toString(36)}` },
      xml('query', { xmlns: DISCO_ITEMS_NS, node: COMMAND_NS }),
    ),
    15000,
  );
  const query = result.getChild('query', DISCO_ITEMS_NS);
  if (!query) return [];
  const commands: XmppInlineCommand[] = [];
  for (const item of query.getChildren('item')) {
    const jid = (item.attrs.jid as string) || targetJid;
    const node = item.attrs.node as string | undefined;
    const name = (item.attrs.name as string | undefined) || node;
    if (!node || !name) continue;
    commands.push({ jid, node, name });
  }
  return commands;
}

export async function runAdhocCommand(targetJid: string, node: string): Promise<string> {
  return executeCommand(targetJid, node);
}

// El servidor registra "elevated" como comando ad-hoc XEP-0050 real (no un
// alias de texto) -- ver openclaw-xmpp OPERATIONS.md. Reemplaza el nodo
// "approval-bypass" retirado en xmpp-elevated-session-command: mismo
// contrato de campos, ahora respaldado por SessionEntry.elevatedLevel en
// vez de execSecurity/execAsk directo. executeCommand ejecuta el mismo
// camino XEP-0050 que el resto de comandos ad-hoc del cliente.
export async function setElevatedSession(targetJid: string, enabled: boolean, minutes = 10): Promise<string> {
  const mode = enabled ? 'on' : 'off';
  const form: DataForm = {
    type: 'submit',
    fields: [
      { var: 'mode', value: mode },
      ...(enabled ? [{ var: 'minutes', value: String(minutes) }] : []),
    ],
  };
  return executeCommand(targetJid, 'elevated', form);
}

// Consulta el estado real del bypass en el servidor -- necesario porque el
// bypass expira solo (timer server-side, ver openclaw-xmpp design.md), y
// sin esto el switch del cliente se quedaría "prendido" tras la expiración
// hasta que el usuario lo tocara de nuevo.
//
// Lee el campo estructurado que el servidor adjunta (var=active/
// remaining-seconds en un <x type="result">), no el texto libre -- ver
// xmpp-approval-unified-contract/xmpp-elevated-session-command.
export async function getElevatedSessionStatus(targetJid: string): Promise<{ active: boolean; remainingMinutes?: number }> {
  const form: DataForm = { type: 'submit', fields: [{ var: 'mode', value: 'status' }] };
  const { fields } = await executeCommandWithFields(targetJid, 'elevated', form);
  if (fields.active !== 'true') return { active: false };
  const remainingSeconds = Number.parseInt(fields['remaining-seconds'] ?? '', 10);
  if (!Number.isFinite(remainingSeconds)) return { active: true };
  return { active: true, remainingMinutes: Math.ceil(remainingSeconds / 60) };
}
