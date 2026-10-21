import { parse } from 'ltx';
import { brainUrl, parseFleetSnapshot } from '@/xmpp/fleet';

const NS = 'urn:joework:monitoring:2';
const item = (inner: string, ns = NS) =>
  parse(`<item id="1"><monitoring xmlns="${ns}" generated-at="x">${inner}</monitoring></item>`);

describe('fleet snapshot', () => {
  const snap = parseFleetSnapshot(item(
    '<instance id="a" jid="Bot@x.org" brain_url="https://wiki/a"/>' +
    '<instance id="b"><jid>b@x.org</jid><brain-url>http://wiki/b</brain-url></instance>' +
    '<instance id="c" jid="c@x.org" brain-url="file:///etc/passwd"/>'));

  it('parsea atributos e hijos de texto', () => expect(snap.entities).toHaveLength(3));
  it('devuelve https, sin distinguir mayúsculas en el jid', () =>
    expect(brainUrl(snap, 'bot@X.org')).toBe('https://wiki/a'));
  it('rechaza http y rutas locales', () => {
    expect(brainUrl(snap, 'b@x.org')).toBe('');
    expect(brainUrl(snap, 'c@x.org')).toBe('');
  });
  it('sin declaración o jid vacío: nada', () => {
    expect(brainUrl(snap, 'z@x.org')).toBe('');
    expect(brainUrl(snap, '')).toBe('');
  });
  it('namespace ajeno: snapshot vacío', () =>
    expect(parseFleetSnapshot(item('<instance jid="a"/>', 'urn:other')).entities).toEqual([]));

  const generated = (gen: string, inner = '') =>
    parse(`<item id="1"><monitoring xmlns="${NS}" generated-at="${gen}">${inner}</monitoring></item>`);

  it('parsea metrics, operational, status y genera cost/operations', () => {
    const snap = parseFleetSnapshot(generated('x',
      '<instance id="a" jid="x@o.org" entity-kind="worker" lifecycle="hibernated">' +
      '<metrics><metric name="cost" value="12.50" currency="USD"/><metric name="cpu" value="40"/></metrics>' +
      '<operational><field name="turn" value="3"/><field name="mode">chat</field></operational>' +
      '</instance>'));
    expect(snap.generatedAt).toBe('x');
    expect(snap.stale).toBe(false);
    expect(snap.entities).toHaveLength(1);
    const e = snap.entities[0];
    expect(e.metrics).toHaveLength(2);
    expect(e.operational).toEqual({ turn: '3', mode: 'chat' });
    expect(e.status).toBe('hibernated');
    expect(snap.cost).toHaveLength(1);
    expect(snap.cost[0]).toMatchObject({ name: 'cost', value: '12.50', currency: 'USD', instance: 'a' });
    expect(snap.operations).toHaveLength(1);
    expect(snap.operations[0]).toMatchObject({ instance: 'a', 'entity-kind': 'worker', fields: { turn: '3', mode: 'chat' } });
  });

  it('marca stale por timestamp viejo (epoch) y no por vacío', () => {
    expect(parseFleetSnapshot(generated('1600000000')).stale).toBe(true);
    expect(parseFleetSnapshot(generated('')).stale).toBe(false);
  });

  it('stale declarado gana', () => {
    const root = parse(`<item id="1"><monitoring xmlns="${NS}" stale="true"><instance id="a"/></monitoring></item>`);
    expect(parseFleetSnapshot(root).stale).toBe(true);
  });
});
