import { base64FromBytes, sha1Hex } from '@/xmpp/sha1';

describe('sha1', () => {
  it('sha1 de "abc" (vector de la spec)', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('sha1 de cadena vacía', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('base64 de bytes', () => {
    const bytes = new TextEncoder().encode('hola');
    expect(base64FromBytes(bytes)).toBe('aG9sYQ==');
  });

  it('base64 del hash de abc', () => {
    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) bytes[i] = Number.parseInt(sha1Hex('abc').slice(i * 2, i * 2 + 2), 16);
    expect(base64FromBytes(bytes)).toBe('qZk+NkcGgWq6PiVxeFDCbJzQ2J0=');
  });
});
