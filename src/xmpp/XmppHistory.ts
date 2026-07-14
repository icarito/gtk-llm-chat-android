/**
 * Local cache for XMPP messages, per contact (bare JID).
 *
 * Mirror of the GTK client's gtk_llm_chat/xmpp_history.py — same schema,
 * same dedupe rules, same query surface. Own SQLite file; it is a cache of
 * the server-side MAM archive, never the source of truth.
 */
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'xmpp_history.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bare_jid TEXT NOT NULL,
    body TEXT NOT NULL,
    direction TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    mam_id TEXT,
    UNIQUE(bare_jid, mam_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(bare_jid, timestamp);
`;

export type Direction = 'in' | 'out';

export interface HistoryRow {
  body: string;
  direction: Direction;
  timestamp: string;
  mam_id: string | null;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await db.execAsync('PRAGMA journal_mode=WAL;');
      await db.execAsync(SCHEMA);
      await cleanupMamShadowDuplicates(db);
      return db;
    });
  }
  return dbPromise;
}

function parseTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

async function cleanupMamShadowDuplicates(db: SQLite.SQLiteDatabase, windowSeconds = 30): Promise<void> {
  const mamRows = await db.getAllAsync<{
    id: number;
    bare_jid: string;
    body: string;
    direction: Direction;
    timestamp: string;
  }>(
    'SELECT id, bare_jid, body, direction, timestamp FROM messages WHERE mam_id IS NOT NULL',
  );
  const deleteIds = new Set<number>();

  for (const row of mamRows) {
    const target = parseTs(row.timestamp);
    if (target === null) continue;
    const shadows = await db.getAllAsync<{ id: number; timestamp: string }>(
      'SELECT id, timestamp FROM messages '
        + 'WHERE bare_jid = ? AND body = ? AND direction = ? AND mam_id IS NULL',
      [row.bare_jid, row.body, row.direction],
    );
    for (const shadow of shadows) {
      const candidate = parseTs(shadow.timestamp);
      if (candidate === null) continue;
      if (Math.abs(target - candidate) <= windowSeconds * 1000) {
        deleteIds.add(shadow.id);
      }
    }
  }

  for (const id of deleteIds) {
    await db.runAsync('DELETE FROM messages WHERE id = ?', [id]);
  }
}

export const XmppHistory = {
  async init(): Promise<void> {
    await getDb();
  },

  /** Insert a message. Returns true if a new row was created. */
  async recordMessage(
    bareJid: string,
    body: string,
    direction: Direction,
    timestamp: string,
    mamId: string | null = null,
  ): Promise<boolean> {
    const db = await getDb();
    const result = await db.runAsync(
      'INSERT OR IGNORE INTO messages (bare_jid, body, direction, timestamp, mam_id) VALUES (?, ?, ?, ?, ?)',
      [bareJid, body, direction, timestamp, mamId],
    );
    return result.changes > 0;
  },

  /** Newest `limit` messages, returned oldest-first for rendering. */
  async getRecent(bareJid: string, limit = 50): Promise<HistoryRow[]> {
    const db = await getDb();
    return db.getAllAsync<HistoryRow>(
      'SELECT body, direction, timestamp, mam_id FROM ('
        + 'SELECT body, direction, timestamp, mam_id FROM messages '
        + 'WHERE bare_jid = ? ORDER BY timestamp DESC LIMIT ?'
        + ') ORDER BY timestamp ASC',
      [bareJid, limit],
    );
  },

  /** The page of messages immediately older than `beforeTimestamp`. */
  async getBefore(bareJid: string, beforeTimestamp: string, limit = 50): Promise<HistoryRow[]> {
    const db = await getDb();
    return db.getAllAsync<HistoryRow>(
      'SELECT body, direction, timestamp, mam_id FROM ('
        + 'SELECT body, direction, timestamp, mam_id FROM messages '
        + 'WHERE bare_jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?'
        + ') ORDER BY timestamp ASC',
      [bareJid, beforeTimestamp, limit],
    );
  },

  /** Timestamp of the newest cached message — the anchor for MAM catch-up. */
  async getLatestTimestamp(bareJid: string): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ timestamp: string }>(
      'SELECT timestamp FROM messages WHERE bare_jid = ? ORDER BY timestamp DESC LIMIT 1',
      [bareJid],
    );
    return row?.timestamp ?? null;
  },

  /**
   * Attach a MAM archive id to a message we already stored live (sent or
   * received without going through the archive). Without this, the same
   * message comes back from MAM with a mam_id, fails to match the UNIQUE
   * constraint against the live row (mam_id NULL), and renders twice.
   */
  async attachMamToRecentMessage(
    bareJid: string,
    body: string,
    direction: Direction,
    timestamp: string,
    mamId: string,
    windowSeconds = 30,
  ): Promise<boolean> {
    const target = parseTs(timestamp);
    if (target === null || !mamId) return false;
    const db = await getDb();
    const candidates = await db.getAllAsync<{ id: number; timestamp: string }>(
      'SELECT id, timestamp FROM messages '
        + 'WHERE bare_jid = ? AND direction = ? AND body = ? AND mam_id IS NULL '
        + 'ORDER BY timestamp DESC LIMIT 10',
      [bareJid, direction, body],
    );
    for (const row of candidates) {
      const candidate = parseTs(row.timestamp);
      if (candidate === null) continue;
      if (Math.abs(target - candidate) <= windowSeconds * 1000) {
        await db.runAsync(
          'UPDATE messages SET timestamp = ?, mam_id = ? WHERE id = ?',
          [timestamp, mamId, row.id],
        );
        return true;
      }
    }
    return false;
  },

  async clear(bareJid?: string): Promise<void> {
    const db = await getDb();
    if (bareJid) {
      await db.runAsync('DELETE FROM messages WHERE bare_jid = ?', [bareJid]);
    } else {
      await db.runAsync('DELETE FROM messages');
    }
  },

  async cleanupMamShadowDuplicates(): Promise<void> {
    const db = await getDb();
    await cleanupMamShadowDuplicates(db);
  },
};
