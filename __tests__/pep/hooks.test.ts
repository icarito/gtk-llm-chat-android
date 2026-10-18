import { xml } from '@xmpp/client';
import { parseHook } from '@/xmpp/pep/hooks';
import {
  NS_HOOKS_ACTIVITY,
  NS_HOOKS_APPROVAL,
  NS_HOOKS_PROGRESS,
  capsNotifyFeatures,
} from '@/xmpp/pep/namespaces';

const PUBSUB_EVENT = 'http://jabber.org/protocol/pubsub#event';

function hookItem(node: string, text: string) {
  return xml(
    'item',
    { xmlns: PUBSUB_EVENT, id: 'current' },
    xml('payload', { xmlns: node }, text),
  );
}

function json(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

describe('parseHook', () => {
  it('parsea un hook de actividad con todos los campos base', () => {
    const hook = parseHook(
      hookItem(
        NS_HOOKS_ACTIVITY,
        json({
          contractVersion: 1,
          event: 'activity',
          state: 'processing',
          sessionKey: 'agent:main',
          originJid: 'bot@example.org',
          target: 'operator@example.org',
          timestamp: '2026-10-18T05:00:00Z',
          pendingCount: 2,
        }),
      ),
      NS_HOOKS_ACTIVITY,
    );

    expect(hook).toEqual({
      node: NS_HOOKS_ACTIVITY,
      contractVersion: 1,
      event: 'activity',
      state: 'processing',
      sessionKey: 'agent:main',
      originJid: 'bot@example.org',
      target: 'operator@example.org',
      timestamp: '2026-10-18T05:00:00Z',
      pendingCount: 2,
    });
  });

  it('infiere el evento del nodo cuando falta el campo event', () => {
    const hook = parseHook(
      hookItem(NS_HOOKS_PROGRESS, json({ state: 'start', detail: 'leyendo repo' })),
      NS_HOOKS_PROGRESS,
    );

    expect(hook?.event).toBe('progress');
    expect(hook?.state).toBe('start');
    expect(hook).toMatchObject({ event: 'progress', state: 'start', detail: 'leyendo repo' });
  });

  it('parsea una aprobación y normaliza expiresAtMs numérico', () => {
    const hook = parseHook(
      hookItem(
        NS_HOOKS_APPROVAL,
        json({
          event: 'approval',
          state: 'pending',
          approvalId: 'deadbeef',
          stanzaId: 'oc-123',
          jid: 'bot@example.org/openclaw',
          expiresAtMs: '1758900000000',
          command: 'rm -rf /tmp/x',
        }),
      ),
      NS_HOOKS_APPROVAL,
    );

    expect(hook).toMatchObject({
      event: 'approval',
      approvalId: 'deadbeef',
      stanzaId: 'oc-123',
      jid: 'bot@example.org/openclaw',
      expiresAtMs: 1758900000000,
      command: 'rm -rf /tmp/x',
    });
  });

  it('acepta directamente el elemento payload con el xmlns del nodo', () => {
    const payload = xml(
      'activity',
      { xmlns: NS_HOOKS_ACTIVITY },
      json({ event: 'activity', state: 'available' }),
    );

    expect(parseHook(payload, NS_HOOKS_ACTIVITY)).toMatchObject({ event: 'activity', state: 'available' });
  });

  it('devuelve null con JSON inválido, sin lanzar', () => {
    expect(() => parseHook(hookItem(NS_HOOKS_ACTIVITY, '{no json'), NS_HOOKS_ACTIVITY)).not.toThrow();
    expect(parseHook(hookItem(NS_HOOKS_ACTIVITY, '{no json'), NS_HOOKS_ACTIVITY)).toBeNull();
  });

  it('devuelve null si el xmlns del payload no coincide con el nodo', () => {
    expect(parseHook(hookItem(NS_HOOKS_ACTIVITY, json({ state: 'available' })), NS_HOOKS_PROGRESS)).toBeNull();
  });

  it('devuelve null si el JSON no es un objeto', () => {
    expect(parseHook(hookItem(NS_HOOKS_ACTIVITY, '[]'), NS_HOOKS_ACTIVITY)).toBeNull();
    expect(parseHook(hookItem(NS_HOOKS_ACTIVITY, 'null'), NS_HOOKS_ACTIVITY)).toBeNull();
  });
});

describe('capsNotifyFeatures', () => {
  it('anuncia telemetría nueva, legacy y los tres hooks', () => {
    expect(capsNotifyFeatures()).toEqual([
      'urn:openclaw:telemetry:0+notify',
      'urn:nanoclaw:telemetry:0+notify',
      'urn:openclaw:hooks:activity:0+notify',
      'urn:openclaw:hooks:approval:0+notify',
      'urn:openclaw:hooks:progress:0+notify',
    ]);
  });
});
