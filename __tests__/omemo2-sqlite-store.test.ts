import 'react-native-get-random-values';
import { SqliteOmemoStore } from '@/omemo2/sqliteStore';

const mockRows = new Map<string, string>();
const mockSecure = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mockSecure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockSecure.set(k, v); },
}));
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async () => {},
    getFirstAsync: async (_sql: string, k: string) => (mockRows.has(k) ? { v: mockRows.get(k) } : null),
    runAsync: async (sql: string, k: string, v?: string) => {
      if (sql.startsWith('DELETE')) mockRows.delete(k);
      else mockRows.set(k, v!);
    },
  }),
}));

describe('SqliteOmemoStore', () => {
  test('ida y vuelta; en disco no queda el texto plano; la clave vive en SecureStore', async () => {
    const s = new SqliteOmemoStore();
    expect(await s.get('a')).toBeNull();
    await s.set('a', 'secreto-ñ');
    expect(await s.get('a')).toBe('secreto-ñ');
    expect(mockRows.get('a')).not.toContain('secreto');
    expect(mockSecure.get('omemo2_db_key')).toHaveLength(64);
    await s.set('a', 'otro');
    expect(await new SqliteOmemoStore().get('a')).toBe('otro'); // misma clave persistida
    await s.remove('a');
    expect(await s.get('a')).toBeNull();
  });

  test('un valor movido a otra clave no descifra (AAD)', async () => {
    const s = new SqliteOmemoStore();
    await s.set('x', 'uno');
    mockRows.set('y', mockRows.get('x')!);
    await expect(s.get('y')).rejects.toThrow();
  });
});
