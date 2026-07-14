import type { ActionDispatcher, NanoClawAction, PendingTextualCommand } from '@/types/xmpp';

const NC_PREFIXES = ['/nc', '!nc'];

export class TextualFallback {
  private dispatcher: ActionDispatcher;
  private sendPlain: (to: string, text: string) => void;
  private pending: Map<string, PendingTextualCommand> = new Map();

  constructor(dispatcher: ActionDispatcher, sendPlain: (to: string, text: string) => void) {
    this.dispatcher = dispatcher;
    this.sendPlain = sendPlain;
  }

  handleMessage(jid: string, body: string): boolean {
    const trimmed = body.trim();

    let matchedPrefix: string | null = null;
    for (const prefix of NC_PREFIXES) {
      if (trimmed === prefix || trimmed.startsWith(prefix + ' ')) {
        matchedPrefix = prefix;
        break;
      }
    }

    if (!matchedPrefix) {
      return this.handleParamReply(jid, trimmed);
    }

    const arg = trimmed.slice(matchedPrefix.length).trim();

    if (arg === '' || arg === 'help') {
      this.showHelp(jid);
      return true;
    }

    const action = this.dispatcher.getAction(arg);
    if (!action) {
      this.sendPlain(
        jid,
        `Comando "${arg}" no encontrado.\n\nUsa /nc o !nc para ver la lista de comandos disponibles.`,
      );
      return true;
    }

    if (action.params.length === 0) {
      try {
        const result = action.handler({});
        const text = typeof result === 'string' ? result : '';
        this.sendPlain(jid, `${action.name}:\n${text}`);
      } catch (err) {
        this.sendPlain(jid, `Error en ${action.name}: ${String(err)}`);
      }
      return true;
    }

    this.startCommand(jid, action);
    return true;
  }

  hasPending(jid: string): boolean {
    return this.pending.has(`txt:${jid}`);
  }

  cancelPending(jid: string): void {
    this.pending.delete(`txt:${jid}`);
  }

  private showHelp(jid: string): void {
    const actions = this.dispatcher.listActions();
    if (actions.length === 0) {
      this.sendPlain(jid, 'NanoClaw: No hay comandos de control disponibles.');
      return;
    }

    const lines = actions.map((a) => {
      const params =
        a.params.length > 0
          ? ` [${a.params.map((p) => (p.required ? `<${p.label}>` : `[${p.label}]`)).join(' ')}]`
          : '';
      return `• /nc ${a.node}${params} — ${a.description}`;
    });

    this.sendPlain(
      jid,
      `Comandos NanoClaw:\n\n${lines.join('\n')}\n\n` +
        'Usa /nc <comando> o !nc <comando> para ejecutar. Si el comando tiene parámetros, te los pediré uno por uno.',
    );
  }

  private startCommand(jid: string, action: NanoClawAction): void {
    const remaining = action.params.map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      options: p.options,
      required: p.required,
    }));

    const session: PendingTextualCommand = {
      node: action.node,
      jid,
      collected: new Map(),
      remaining,
      currentParamIdx: 0,
    };

    this.pending.set(`txt:${jid}`, session);
    this.promptCurrentParam(jid, session);
  }

  private promptCurrentParam(jid: string, session: PendingTextualCommand): void {
    if (session.currentParamIdx >= session.remaining.length) {
      const params: Record<string, string> = {};
      for (const [k, v] of session.collected) params[k] = v;
      const action = this.dispatcher.getAction(session.node);
      if (action) {
        try {
          const result = action.handler(params);
          const text = typeof result === 'string' ? result : '';
          this.sendPlain(jid, `${action.name} completado:\n${text}`);
        } catch (err) {
          this.sendPlain(jid, `Error en ${action.name}: ${String(err)}`);
        }
      }
      this.pending.delete(`txt:${jid}`);
      return;
    }

    const param = session.remaining[session.currentParamIdx]!;

    let prompt = `${param.label}`;
    if (param.type === 'boolean') {
      prompt += '\n(Opciones: si / no)';
    } else if (param.options && param.options.length > 0) {
      const opts = param.options.map((o, i) => `${i + 1}) ${o.label}`).join('\n');
      prompt += `\n${opts}`;
    }
    if (!param.required) {
      prompt += '\n(Responde "-" para omitir)';
    }
    prompt += '\n(Responde "cancelar" para cancelar el comando)';

    this.sendPlain(jid, prompt);
  }

  private handleParamReply(jid: string, body: string): boolean {
    const session = this.pending.get(`txt:${jid}`);
    if (!session) return false;

    const trimmed = body.trim();

    if (trimmed.toLowerCase() === 'cancelar' || trimmed.toLowerCase() === 'cancel') {
      this.pending.delete(`txt:${jid}`);
      this.sendPlain(jid, 'Comando cancelado.');
      return true;
    }

    const param = session.remaining[session.currentParamIdx]!;

    if (trimmed === '-' && !param.required) {
      session.collected.set(param.name, '');
      session.currentParamIdx++;
      this.promptCurrentParam(jid, session);
      return true;
    }

    if (param.type === 'boolean') {
      const lc = trimmed.toLowerCase();
      if (lc === 'si' || lc === 'sí' || lc === 'yes' || lc === 'true' || lc === '1') {
        session.collected.set(param.name, 'true');
      } else if (lc === 'no' || lc === 'false' || lc === '0') {
        session.collected.set(param.name, 'false');
      } else {
        this.sendPlain(jid, 'Responde "si" o "no".');
        return true;
      }
      session.currentParamIdx++;
      this.promptCurrentParam(jid, session);
      return true;
    }

    if (param.options && param.options.length > 0) {
      const num = Number(trimmed);
      if (Number.isInteger(num) && num >= 1 && num <= param.options.length) {
        session.collected.set(param.name, param.options[num - 1]!.value);
      } else {
        const lc = trimmed.toLowerCase();
        const match = param.options.find((o) => o.label.toLowerCase() === lc || o.value.toLowerCase() === lc);
        if (match) {
          session.collected.set(param.name, match.value);
        } else {
          this.sendPlain(jid, 'Opción no reconocida. Responde con el número o nombre de la opción.');
          return true;
        }
      }
      session.currentParamIdx++;
      this.promptCurrentParam(jid, session);
      return true;
    }

    if (!trimmed && param.required) {
      this.sendPlain(jid, `${param.label} es obligatorio. Proporciona un valor.`);
      return true;
    }

    session.collected.set(param.name, trimmed);
    session.currentParamIdx++;
    this.promptCurrentParam(jid, session);
    return true;
  }
}
