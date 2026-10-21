import * as SQLite from 'expo-sqlite';

export type HistoryDatabase = Pick<SQLite.SQLiteDatabase,
  'execAsync' | 'getAllAsync' | 'getFirstAsync' | 'runAsync'>;

export const openDatabaseAsync = SQLite.openDatabaseAsync;
