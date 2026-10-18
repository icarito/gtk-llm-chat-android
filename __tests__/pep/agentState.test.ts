import { AgentStateStore } from '@/xmpp/pep/agentState';
import type { ActivityHook, ApprovalHook, HookEvent, ProgressHook } from '@/xmpp/pep/hooks';
import type { AgentTelemetry } from '@/xmpp/pep/telemetry';

function telemetry(overrides: Partial<AgentTelemetry> = {}): AgentTelemetry {
  return {
    activity: 'processing',
    availability: 'available',
    context: { used: 1000, max: 2000, scope: 'active', maxSource: 'config' },
    tokens: { total: 500, input: 400, output: 100, requests: 3, scope: 'session' },
    cost: { usd: 0.0012, scope: 'last-request' },
    sessionCostUsd: 0.004,
    dayCostUsd: 0.01,
    model: 'deepseek/deepseek-v4-pro',
    tool: 'exec',
    sessionStatus: 'running',
    ...overrides,
  };
}

type HookExtra = Partial<ActivityHook & ApprovalHook & ProgressHook>;

function hook(event: string, state: string, extra: HookExtra = {}): HookEvent {
  return { node: `urn:openclaw:hooks:${event}:0`, event, state, ...extra };
}

function approval(overrides: Partial<ApprovalHook> = {}): ApprovalHook {
  return {
    node: 'urn:openclaw:hooks:approval:0',
    event: 'approval',
    state: 'pending',
    approvalId: 'a1',
    expiresAtMs: 2000,
    ...overrides,
  };
}

describe('AgentStateStore', () => {
  it('guarda la telemetría por JID bare', () => {
    const store = new AgentStateStore();
    store.applyTelemetry('bot@example.org/phone', telemetry());

    const state = store.get('bot@example.org');

    expect(state?.activity).toBe('processing');
    expect(state?.tokens.total).toBe(500);
    expect(state?.cost.usd).toBe(0.0012);
    expect(state?.model).toBe('deepseek/deepseek-v4-pro');
    expect(store.get('bot@example.org/otro')).toBe(state);
  });

  it('aplica hooks de actividad, progreso y aprobación', () => {
    const store = new AgentStateStore();
    store.applyTelemetry('bot@example.org', telemetry());

    store.applyHook('bot@example.org', hook('activity', 'busy', { pendingCount: 3 }));
    const progress: ProgressHook = {
      ...hook('progress', 'start'),
      state: 'start',
      detail: 'compilando',
    };
    store.applyHook('bot@example.org', progress);
    store.applyHook('bot@example.org', approval());

    const state = store.get('bot@example.org');
    expect(state?.activity).toBe('busy');
    expect(state?.pendingCount).toBe(3);
    expect(state?.progress?.detail).toBe('compilando');
    expect(state?.approvals.get('a1')?.approvalId).toBe('a1');
  });

  it('sólo devuelve aprobaciones pendientes, no vencidas ni decididas', () => {
    const store = new AgentStateStore();
    store.applyHook('bot@example.org', approval({ approvalId: 'vigente', expiresAtMs: 5000 }));
    store.applyHook('bot@example.org', approval({ approvalId: 'sin-vencimiento', expiresAtMs: undefined }));
    store.applyHook('bot@example.org', approval({ approvalId: 'vencida', expiresAtMs: 1000 }));
    store.applyHook('bot@example.org', approval({ approvalId: 'resuelta', state: 'resolved' }));
    store.applyHook('bot@example.org', approval({ approvalId: 'decidida', decision: 'deny' }));

    const pending = store.pendingApprovals('bot@example.org', 2000).map((a) => a.approvalId);

    expect(pending).toEqual(['vigente', 'sin-vencimiento']);
    expect(store.pendingApprovals('otro@example.org', 2000)).toEqual([]);
  });

  it('expone un timeline de los cinco hooks más recientes, el último primero', () => {
    const store = new AgentStateStore();
    for (const state of ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis']) {
      store.applyHook('bot@example.org', hook('activity', state));
    }

    const timeline = store.timeline('bot@example.org');

    expect(timeline).toHaveLength(5);
    expect(timeline.map((h) => h.state)).toEqual(['seis', 'cinco', 'cuatro', 'tres', 'dos']);
    expect(store.timeline('otro@example.org')).toEqual([]);
  });

  it('notifica a los suscriptores y deja de hacerlo al desuscribirse', () => {
    const store = new AgentStateStore();
    const calls: Array<[string, string]> = [];
    const unsubscribe = store.subscribe((jid, state) => calls.push([jid, state.activity]));

    store.applyHook('bot@example.org/res', hook('activity', 'available'));
    unsubscribe();
    store.applyHook('bot@example.org', hook('activity', 'paused'));

    expect(calls).toEqual([['bot@example.org', 'available']]);
  });
});
