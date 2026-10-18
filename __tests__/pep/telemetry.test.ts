import { xml } from '@xmpp/client';
import { formatCost, formatTool, parseTelemetry } from '@/xmpp/pep/telemetry';
import { NS_TELEMETRY, NS_TELEMETRY_LEGACY } from '@/xmpp/pep/namespaces';

const PUBSUB_EVENT = 'http://jabber.org/protocol/pubsub#event';

function telemetryItem(xmlns: string, attrs: Record<string, string>, ...children: ReturnType<typeof xml>[]) {
  return xml(
    'item',
    { xmlns: PUBSUB_EVENT, id: 'current' },
    xml('telemetry', { xmlns, ...attrs }, ...children),
  );
}

describe('parseTelemetry', () => {
  it('lee el payload completo publicado por el gateway', () => {
    const item = telemetryItem(
      NS_TELEMETRY,
      { activity: 'processing', availability: 'available' },
      xml('context', { used: '12000', max: '131072', scope: 'active', maxSource: 'config' }),
      xml('tokens', { total: '51234', input: '48000', output: '3234', requests: '17', scope: 'session' }),
      xml('cost', { usd: '0.0012', scope: 'last-request' }),
      xml('session-cost', { usd: '0.0040', scope: 'session' }),
      xml('day-cost', { usd: '0.0100', scope: 'day-local' }),
      xml('model', {}, 'deepseek/deepseek-v4-pro'),
      xml('tool', {}, 'exec'),
      xml('session', { status: 'running' }),
    );

    expect(parseTelemetry(item)).toEqual({
      activity: 'processing',
      availability: 'available',
      context: { used: 12000, max: 131072, scope: 'active', maxSource: 'config' },
      tokens: {
        total: 51234,
        input: 48000,
        output: 3234,
        requests: 17,
        scope: 'session',
      },
      cost: { usd: 0.0012, scope: 'last-request' },
      sessionCostUsd: 0.004,
      dayCostUsd: 0.01,
      model: 'deepseek/deepseek-v4-pro',
      tool: 'exec',
      sessionStatus: 'running',
    });
  });

  it('acepta el elemento <telemetry> directamente', () => {
    const telemetry = xml('telemetry', { xmlns: NS_TELEMETRY, activity: 'available' }, xml('model', {}, 'm1'));

    expect(parseTelemetry(telemetry)).toMatchObject({ activity: 'available', model: 'm1' });
  });

  it('acepta el namespace legacy de NanoClaw', () => {
    const item = telemetryItem(NS_TELEMETRY_LEGACY, { activity: 'busy' });

    expect(parseTelemetry(item)?.activity).toBe('busy');
  });

  it('no convierte atributos ausentes o vacíos en cero', () => {
    const item = telemetryItem(
      NS_TELEMETRY,
      {},
      xml('context', { used: '', max: '0' }),
      xml('tokens', {}),
      xml('cost', {}),
    );

    const telemetry = parseTelemetry(item);

    expect(telemetry).not.toBeNull();
    expect(telemetry?.context.used).toBeUndefined();
    expect(telemetry?.context.max).toBe(0);
    expect(telemetry?.tokens.total).toBeUndefined();
    expect(telemetry?.cost.usd).toBeUndefined();
    expect(telemetry?.sessionCostUsd).toBeUndefined();
    expect(telemetry?.model).toBeUndefined();
  });

  it('descarta números no finitos', () => {
    const item = telemetryItem(NS_TELEMETRY, {}, xml('cost', { usd: 'no-es-numero' }));

    expect(parseTelemetry(item)?.cost.usd).toBeUndefined();
  });

  it('devuelve null para un item sin telemetría o de otro namespace', () => {
    expect(parseTelemetry(xml('item', { xmlns: PUBSUB_EVENT, id: 'current' }))).toBeNull();
    expect(
      parseTelemetry(
        xml('item', { xmlns: PUBSUB_EVENT }, xml('telemetry', { xmlns: 'urn:otro:0' })),
      ),
    ).toBeNull();
  });
});

describe('formatCost', () => {
  it('es honesto con la ausencia de tarifa', () => {
    expect(formatCost(undefined)).toBe('sin tarifa');
    expect(formatCost(0)).toBe('sin tarifa');
  });

  it('usa cuatro decimales por debajo de un centavo y dos por encima', () => {
    expect(formatCost(0.0012)).toBe('$0.0012');
    expect(formatCost(0.0099)).toBe('$0.0099');
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(1.2345)).toBe('$1.23');
  });
});

describe('formatTool', () => {
  it('trata la ausencia de herramienta como ninguna', () => {
    expect(formatTool(undefined)).toBe('ninguna');
    expect(formatTool('')).toBe('ninguna');
    expect(formatTool('  ')).toBe('ninguna');
    expect(formatTool('exec')).toBe('exec');
  });
});
