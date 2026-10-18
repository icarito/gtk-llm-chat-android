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
});
