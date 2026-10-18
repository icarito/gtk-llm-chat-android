import { formatFingerprint } from '@/components/encryption/format';

describe('formatFingerprint', () => {
  it('agrupa en bloques de 8 y pasa a minúsculas', () => {
    expect(formatFingerprint('AABBCCDD11223344deadbeef')).toBe('aabbccdd 11223344 deadbeef');
  });
  it('vacío → vacío', () => {
    expect(formatFingerprint('')).toBe('');
  });
});
