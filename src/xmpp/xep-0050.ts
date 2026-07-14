import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import type { ActionDispatcher, NanoClawAction, FormField } from '@/types/xmpp';
import {
  buildRequestForm,
  parseSubmitForm,
  isFormSubmit,
  isFormCancel,
} from './xep-0004';

const COMMAND_NS = 'http://jabber.org/protocol/commands';
const DISCO_INFO_NS = 'http://jabber.org/protocol/disco#info';
const DISCO_ITEMS_NS = 'http://jabber.org/protocol/disco#items';

interface PendingSession {
  node: string;
  jid: string;
}

export class Xep0050Handler {
  private dispatcher: ActionDispatcher;
  private pending: Map<string, PendingSession> = new Map();
  private onActionComplete?: (node: string, result: string, fromJid: string) => void;
  private agentGroupId: string | null;

  constructor(
    dispatcher: ActionDispatcher,
    options?: {
      onActionComplete?: (node: string, result: string, fromJid: string) => void;
      agentGroupId?: string | null;
    },
  ) {
    this.dispatcher = dispatcher;
    this.onActionComplete = options?.onActionComplete;
    this.agentGroupId = options?.agentGroupId ?? null;
  }

  private sessionKey(from: string, id: string): string {
    return `${from}::${id}`;
  }

  async handleIq(iq: Element): Promise<Element | null> {
    const type = iq.attrs.type as string;
    if (type !== 'get' && type !== 'set') return null;

    const command = iq.getChild('command', COMMAND_NS);
    if (command) return await this.handleCommand(iq, command);

    const discoItems = iq.getChild('query', DISCO_ITEMS_NS);
    if (discoItems) return this.handleDiscoItems(iq);

    const discoInfo = iq.getChild('query', DISCO_INFO_NS);
    if (discoInfo) return this.handleDiscoInfo(iq);

    return null;
  }

  private handleDiscoItems(iq: Element): Element {
    const from = (iq.attrs.from as string) || '';
    const to = (iq.attrs.to as string) || '';
    const id = (iq.attrs.id as string) || '';
    const node = iq.getChild('query', DISCO_ITEMS_NS)?.attrs.node as string | undefined;

    const actions = this.dispatcher.listActions();

    const items = actions.map((a) =>
      xml('item', {
        jid: to,
        node: a.node,
        name: a.name,
      }),
    );

    if (!node || node === COMMAND_NS) {
      return xml(
        'iq',
        { type: 'result', id, to: from },
        xml('query', { xmlns: DISCO_ITEMS_NS, ...(node ? { node } : {}) }, ...items),
      );
    }

    return xml('iq', { type: 'result', id, to: from }, xml('query', { xmlns: DISCO_ITEMS_NS, node }));
  }

  private handleDiscoInfo(iq: Element): Element {
    const from = (iq.attrs.from as string) || '';
    const id = (iq.attrs.id as string) || '';
    const node = iq.getChild('query', DISCO_INFO_NS)?.attrs.node as string | undefined;

    if (!node || node.startsWith('https://github.com/nanocoai/nanoclaw#')) {
      return xml(
        'iq',
        { type: 'result', id, to: from },
        xml(
          'query',
          { xmlns: DISCO_INFO_NS, ...(node ? { node } : {}) },
          xml('identity', { category: 'automation', type: 'command-list', name: 'NanoClaw' }),
          xml('feature', { var: COMMAND_NS }),
          xml('feature', { var: DISCO_INFO_NS }),
          xml('feature', { var: DISCO_ITEMS_NS }),
        ),
      );
    }

    const action = this.dispatcher.getAction(node);
    if (!action) {
      return xml(
        'iq',
        { type: 'error', id, to: from },
        xml('query', { xmlns: DISCO_INFO_NS, node }),
        xml(
          'error',
          { type: 'cancel', code: '404' },
          xml('item-not-found', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }),
        ),
      );
    }

    return xml(
      'iq',
      { type: 'result', id, to: from },
      xml(
        'query',
        { xmlns: DISCO_INFO_NS, node },
        xml('identity', { category: 'automation', type: 'command-node', name: action.name }),
        xml('feature', { var: COMMAND_NS }),
        ...(action.params.length > 0 ? [xml('feature', { var: 'jabber:x:data' })] : []),
      ),
    );
  }

  private async handleCommand(iq: Element, command: Element): Promise<Element> {
    const from = (iq.attrs.from as string) || '';
    const id = (iq.attrs.id as string) || '';
    const node = command.attrs.node as string | undefined;
    const action = (command.attrs.action as string) || 'execute';
    const sessionid = command.attrs.sessionid as string | undefined;

    if (!node) {
      return this.iqError(from, id, 'bad-request');
    }

    const cmdAction = this.dispatcher.getAction(node);
    if (!cmdAction) {
      return this.commandError(from, id, node, 'item-not-found');
    }

    if (action === 'cancel') {
      if (sessionid) this.pending.delete(this.sessionKey(from, sessionid));
      return xml(
        'iq',
        { type: 'result', id, to: from },
        xml('command', { xmlns: COMMAND_NS, node, sessionid: sessionid ?? '', status: 'canceled' }),
      );
    }

    if (action === 'execute') {
      const newSessionId = `nc-cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      if (cmdAction.params.length === 0) {
        this.pending.set(this.sessionKey(from, newSessionId), { node, jid: from });
        return await this.executeNoParams(from, id, node, newSessionId, cmdAction);
      }

      this.pending.set(this.sessionKey(from, newSessionId), { node, jid: from });
      return this.presentForm(from, id, node, newSessionId, cmdAction);
    }

    if (!sessionid) {
      return this.commandError(from, id, node, 'bad-request', 'Missing sessionid');
    }

    const pending = this.pending.get(this.sessionKey(from, sessionid));
    if (!pending || pending.node !== node) {
      return this.commandError(from, id, node, 'item-not-found');
    }

    if (isFormCancel(command)) {
      this.pending.delete(this.sessionKey(from, sessionid));
      return xml(
        'iq',
        { type: 'result', id, to: from },
        xml('command', { xmlns: COMMAND_NS, node, sessionid: sessionid ?? '', status: 'canceled' }),
      );
    }

    if (!isFormSubmit(command)) {
      return this.presentForm(from, id, node, sessionid, cmdAction);
    }

    const xElement = command.getChild('x', 'jabber:x:data');
    if (!xElement) {
      return this.commandError(from, id, node, 'bad-request', 'Missing data form');
    }

    const params = parseSubmitForm(xElement);
    return await this.executeAndComplete(from, id, node, sessionid, cmdAction, params);
  }

  private presentForm(from: string, id: string, node: string, sessionid: string, action: NanoClawAction): Element {
    const fields: FormField[] = action.params.map((p) => ({
      var: p.name,
      type: p.type,
      label: p.label,
      desc: p.description,
      required: p.required,
      options: p.options,
      value: p.default,
    }));

    const form = buildRequestForm(action.name, [action.description], fields);

    return xml(
      'iq',
      { type: 'result', id, to: from },
      xml(
        'command',
        {
          xmlns: COMMAND_NS,
          node,
          sessionid,
          status: 'executing',
        },
        form,
      ),
    );
  }

  private async executeNoParams(
    from: string,
    id: string,
    node: string,
    sessionid: string,
    action: NanoClawAction,
  ): Promise<Element> {
    try {
      const result = await action.handler({}, { fromJid: from, agentGroupId: this.agentGroupId });
      const text = typeof result === 'string' ? result : '';
      this.onActionComplete?.(node, text, from);
      return this.commandCompleted(from, id, node, sessionid, text);
    } catch (err) {
      return this.commandError(from, id, node, 'internal-server-error', String(err));
    } finally {
      this.pending.delete(this.sessionKey(from, sessionid));
    }
  }

  private async executeAndComplete(
    from: string,
    id: string,
    node: string,
    sessionid: string,
    action: NanoClawAction,
    params: Record<string, string>,
  ): Promise<Element> {
    try {
      const missing: string[] = [];
      for (const p of action.params) {
        if (p.required && (!(p.name in params) || !params[p.name]?.trim())) {
          missing.push(p.label);
        }
      }
      if (missing.length > 0) {
        return this.commandError(from, id, node, 'bad-request', `Parámetros requeridos: ${missing.join(', ')}`);
      }

      const result = await action.handler(params, { fromJid: from, agentGroupId: this.agentGroupId });
      const text = typeof result === 'string' ? result : '';
      this.onActionComplete?.(node, text, from);
      return this.commandCompleted(from, id, node, sessionid, text);
    } catch (err) {
      return this.commandError(from, id, node, 'internal-server-error', String(err));
    } finally {
      this.pending.delete(this.sessionKey(from, sessionid));
    }
  }

  private commandCompleted(from: string, id: string, node: string, sessionid: string, text: string): Element {
    return xml(
      'iq',
      { type: 'result', id, to: from },
      xml(
        'command',
        {
          xmlns: COMMAND_NS,
          node,
          sessionid,
          status: 'completed',
        },
        xml('note', { type: 'info' }, text),
      ),
    );
  }

  private commandError(from: string, id: string, node: string, errorType: string, text?: string): Element {
    const cmdChildren: Element[] = [];
    if (text) cmdChildren.push(xml('note', { type: 'error' }, text));

    return xml(
      'iq',
      { type: 'error', id, to: from },
      xml('command', { xmlns: COMMAND_NS, node, status: 'canceled' }, ...cmdChildren),
      xml(
        'error',
        errorType === 'forbidden'
          ? { type: 'auth', code: '403' }
          : { type: 'cancel', code: errorType === 'item-not-found' ? '404' : '400' },
        xml(`${errorType}`, { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }),
      ),
    );
  }

  private iqError(from: string, id: string, errorType: string): Element {
    return xml(
      'iq',
      { type: 'error', id, to: from },
      xml(
        'error',
        { type: 'modify', code: '400' },
        xml(`${errorType}`, { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }),
      ),
    );
  }

  cleanup(maxAgeMs: number = 300_000): void {
    const now = Date.now();
    for (const [key] of this.pending) {
      const tsMatch = key.match(/nc-cmd-([\w-]+)/);
      if (tsMatch && tsMatch[1]) {
        const ts = parseInt(tsMatch[1], 36);
        if (!isNaN(ts) && now - ts > maxAgeMs) {
          this.pending.delete(key);
        }
      }
    }
  }
}

export function createActionDispatcher(actions: NanoClawAction[]): ActionDispatcher {
  const byNode = new Map<string, NanoClawAction>();
  for (const a of actions) byNode.set(a.node, a);

  return {
    listActions() {
      return [...byNode.values()];
    },
    getAction(node) {
      return byNode.get(node);
    },
    async execute(node, params, ctx) {
      const action = byNode.get(node);
      if (!action) throw new Error(`Unknown action: ${node}`);
      return action.handler(params, ctx);
    },
    registerAction(action) {
      byNode.set(action.node, action);
    },
    unregisterAction(node) {
      byNode.delete(node);
    },
  };
}

export function shortQuestionId(questionId: string): string {
  let h = 0;
  for (let i = 0; i < questionId.length; i++) {
    h = (h * 31 + questionId.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).slice(0, 3);
}

export function matchOptionReply(reply: string, options: { label: string; value: string }[]): string | null {
  const trimmed = reply.trim();
  const asIdx = Number(trimmed);
  if (Number.isInteger(asIdx) && asIdx >= 1 && asIdx <= options.length) {
    return options[asIdx - 1]!.value;
  }
  const lc = trimmed.toLowerCase();
  for (const opt of options) {
    if (opt.label.toLowerCase() === lc || opt.value.toLowerCase() === lc) return opt.value;
  }
  return null;
}

export function normalizeXmppOptions(raw: Array<{ label: string; value: string } | string>): { label: string; value: string }[] {
  return raw.map((o) => {
    if (typeof o === 'string') return { label: o, value: o };
    return { label: o.label, value: o.value };
  });
}
