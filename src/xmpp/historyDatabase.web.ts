import Database from '@tauri-apps/plugin-sql';

type BindValue = string | number | null;
type BindArgs = BindValue[] | [BindValue[]];

function bindValues(args: BindArgs): BindValue[] {
  return Array.isArray(args[0]) ? args[0] : args as BindValue[];
}

// Only the history cache's SQL surface is exposed. Android keeps expo-sqlite.
export async function openDatabaseAsync(name: string) {
  const db = await Database.load(`sqlite:${name}`);
  return {
    async execAsync(sql: string): Promise<void> {
      // History schema/migrations contain no semicolons inside SQL literals.
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
        await db.execute(statement);
      }
    },
    getAllAsync<T>(sql: string, ...args: BindArgs): Promise<T[]> {
      return db.select<T[]>(sql, bindValues(args));
    },
    async getFirstAsync<T>(sql: string, ...args: BindArgs): Promise<T | null> {
      const rows = await db.select<T[]>(sql, bindValues(args));
      return rows[0] ?? null;
    },
    async runAsync(sql: string, ...args: BindArgs) {
      const result = await db.execute(sql, bindValues(args));
      return { changes: result.rowsAffected, lastInsertRowId: result.lastInsertId ?? 0 };
    },
  };
}
