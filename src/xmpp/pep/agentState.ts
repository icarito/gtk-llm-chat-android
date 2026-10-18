import type { ActivityHook, ApprovalHook, HookEvent, ProgressHook } from './hooks';
import type { AgentTelemetry, TelemetryContext, TelemetryCost, TelemetryTokens } from './telemetry';

export interface AgentState {
  telemetry: AgentTelemetry | null;
  activity: string;
  availability: string;
  context: TelemetryContext;
  tokens: TelemetryTokens;
  cost: TelemetryCost;
  sessionCostUsd?: number;
  dayCostUsd?: number;
  model?: string;
  tool?: string;
  sessionStatus?: string;
  pendingCount?: number;
  progress?: ProgressHook;
  approvals: Map<string, ApprovalHook>;
  /** Hooks más recientes primero; `timeline()` devuelve sólo los cinco últimos. */
  timeline: HookEvent[];
}

export type AgentStateListener = (jid: string, state: AgentState) => void;

const TIMELINE_LIMIT = 50;
const TIMELINE_VISIBLE = 5;

function bareJid(jid: string): string {
  return jid.split('/')[0] ?? jid;
}

function emptyState(): AgentState {
  return {
    telemetry: null,
    activity: '',
    availability: '',
    context: {},
    tokens: {},
    cost: {},
    approvals: new Map(),
    timeline: [],
  };
}

/**
 * Último estado conocido por agente (JID bare): telemetría + hooks PEP.
 * Sin dependencias: la sesión XMPP lo alimenta y la UI lo lee.
 */
export class AgentStateStore {
  private readonly states = new Map<string, AgentState>();
  private readonly listeners = new Set<AgentStateListener>();

  private ensure(jid: string): AgentState {
    const key = bareJid(jid);
    let state = this.states.get(key);
    if (!state) {
      state = emptyState();
      this.states.set(key, state);
    }
    return state;
  }

  private notify(jid: string, state: AgentState): void {
    for (const listener of this.listeners) listener(jid, state);
  }

  has(jid: string): boolean {
    return this.states.has(bareJid(jid));
  }

  get(jid: string): AgentState | undefined {
    return this.states.get(bareJid(jid));
  }

  applyTelemetry(jid: string, telemetry: AgentTelemetry): AgentState {
    const key = bareJid(jid);
    const state = this.ensure(key);
    state.telemetry = telemetry;
    if (telemetry.activity !== '') state.activity = telemetry.activity;
    if (telemetry.availability !== '') state.availability = telemetry.availability;
    state.context = telemetry.context;
    state.tokens = telemetry.tokens;
    state.cost = telemetry.cost;
    state.sessionCostUsd = telemetry.sessionCostUsd ?? state.sessionCostUsd;
    state.dayCostUsd = telemetry.dayCostUsd ?? state.dayCostUsd;
    state.model = telemetry.model ?? state.model;
    state.tool = telemetry.tool ?? state.tool;
    state.sessionStatus = telemetry.sessionStatus ?? state.sessionStatus;
    this.notify(key, state);
    return state;
  }

  applyHook(jid: string, hook: HookEvent): AgentState {
    const key = bareJid(jid);
    const state = this.ensure(key);

    switch (hook.event) {
      case 'activity': {
        if (hook.state !== '') state.activity = hook.state;
        const pendingCount = (hook as ActivityHook).pendingCount;
        if (pendingCount !== undefined) state.pendingCount = pendingCount;
        break;
      }
      case 'progress':
        state.progress = hook as ProgressHook;
        break;
      case 'approval': {
        const approvalId = (hook as ApprovalHook).approvalId;
        if (approvalId) state.approvals.set(approvalId, hook as ApprovalHook);
        break;
      }
      default:
        break;
    }

    state.timeline.unshift(hook);
    if (state.timeline.length > TIMELINE_LIMIT) state.timeline.length = TIMELINE_LIMIT;

    this.notify(key, state);
    return state;
  }

  /** Aprobaciones pendientes, sin las vencidas ni las ya decididas. */
  pendingApprovals(jid: string, nowMs: number): ApprovalHook[] {
    const state = this.get(jid);
    if (!state) return [];
    const pending: ApprovalHook[] = [];
    for (const approval of state.approvals.values()) {
      if (approval.state !== 'pending') continue;
      if (approval.decision) continue;
      const expiresAt = approval.expiresAtMs;
      if (expiresAt !== undefined && expiresAt > 0 && expiresAt <= nowMs) continue;
      pending.push(approval);
    }
    return pending;
  }

  /** Los cinco hooks más recientes, el último primero. */
  timeline(jid: string): HookEvent[] {
    return this.get(jid)?.timeline.slice(0, TIMELINE_VISIBLE) ?? [];
  }

  subscribe(listener: AgentStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
