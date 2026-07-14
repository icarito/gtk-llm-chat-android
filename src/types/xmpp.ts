export interface XmppAccountConfig {
  jid: string;
  password: string;
  service: string;
  resource: string;
}

export type XmppConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'error';

export interface XmppContact {
  jid: string;
  name: string;
  subscription: 'none' | 'to' | 'from' | 'both';
  presence: 'online' | 'away' | 'dnd' | 'xa' | 'offline';
  status?: string;
  caps?: string | null;
}

export interface XmppMessage {
  id: string;
  from: string;
  to: string;
  type: 'chat' | 'groupchat';
  body: string;
  timestamp: string;
  /** Who sent it. Authoritative — never infer ownership from `from`, which is
   *  empty for locally-sent messages and bare for MAM ones. */
  direction: 'in' | 'out';
  /** XEP-0313 archive id, when the message came from (or was matched to) MAM. */
  mamId?: string | null;
  isMention?: boolean;
  isGroup: boolean;
  threadId?: string | null;
  replyTo?: {
    text: string;
    sender: string;
  } | null;
  oobUrl?: string | null;
}

export interface XmppQuickResponse {
  label: string;
  value: string;
}

export interface XmppInlineCommand {
  jid: string;
  node: string;
  name: string;
}

export interface XmppPendingAction {
  id: string;
  conversationJid: string;
  messageId: string;
  timestamp: string;
  detail: string;
  kind: 'quick-response' | 'command';
  label: string;
  value?: string;
  jid?: string;
  node?: string;
}

export interface ActionParam {
  name: string;
  label: string;
  type: 'text-single' | 'text-multi' | 'list-single' | 'list-multi' | 'boolean' | 'jid-single';
  required: boolean;
  description?: string;
  options?: { label: string; value: string }[];
  default?: string;
}

export interface ActionContext {
  fromJid: string;
  agentGroupId: string | null;
}

export interface NanoClawAction {
  node: string;
  name: string;
  description: string;
  params: ActionParam[];
  mutating: boolean;
  kind?: 'static' | 'skill';
  skillPrompt?: string;
  handler: (params: Record<string, string>, ctx?: ActionContext) => Promise<string> | string;
}

export interface ActionDispatcher {
  listActions(): NanoClawAction[];
  getAction(node: string): NanoClawAction | undefined;
  execute(node: string, params: Record<string, string>, ctx?: ActionContext): Promise<string>;
  registerAction(action: NanoClawAction): void;
  unregisterAction(node: string): void;
}

export interface PendingXmppQuestion {
  questionId: string;
  platformId: string;
  options: { label: string; value: string }[];
  messageId: string;
  shortId: string;
  title: string;
  question: string;
  actionNodes: string[];
  type: string;
}

export interface FormField {
  var: string;
  type?:
    | 'boolean'
    | 'fixed'
    | 'hidden'
    | 'jid-multi'
    | 'jid-single'
    | 'list-multi'
    | 'list-single'
    | 'text-multi'
    | 'text-single';
  label?: string;
  value?: string | string[];
  desc?: string;
  required?: boolean;
  options?: { label: string; value: string }[];
}

export type FormType = 'form' | 'submit' | 'result' | 'cancel';

export interface DataForm {
  type: FormType;
  title?: string;
  instructions?: string[];
  fields: FormField[];
}

export interface PendingTextualCommand {
  node: string;
  jid: string;
  collected: Map<string, string>;
  remaining: {
    name: string;
    label: string;
    type: string;
    options?: { label: string; value: string }[];
    required: boolean;
  }[];
  currentParamIdx: number;
}
