/**
 * Local cache for XMPP messages, per contact (bare JID).
 *
 * Mirror of the GTK client's gtk_llm_chat/xmpp_history.py — same schema,
 * same dedupe rules, same query surface. Own SQLite file; it is a cache of
 * the server-side MAM archive, never the source of truth.
 */
import * as SQLite from 'expo-sqlite';
import type { XmppInlineCommand, XmppQuickResponse } from '@/types/xmpp';

const DB_NAME = 'xmpp_history.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bare_jid TEXT NOT NULL,
    body TEXT NOT NULL,
    direction TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    mam_id TEXT,
    quick_responses TEXT,
    commands TEXT,
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
  quick_responses: XmppQuickResponse[];
  commands: XmppInlineCommand[];
}

export interface HistoryPreviewRow extends HistoryRow {
  bare_jid: string;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await db.execAsync('PRAGMA journal_mode=WAL;');
      await db.execAsync(SCHEMA);
      await migrateMetadataColumns(db);
      return db;
    });
  }
  return dbPromise;
}

async function migrateMetadataColumns(db: SQLite.SQLiteDatabase): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(messages)');
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('quick_responses')) {
    await db.execAsync('ALTER TABLE messages ADD COLUMN quick_responses TEXT');
  }
  if (!names.has('commands')) {
    await db.execAsync('ALTER TABLE messages ADD COLUMN commands TEXT');
  }
}

function encodeMetadata(value: unknown[] | null | undefined): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null;
}

function decodeMetadata<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

type DbHistoryRow = Omit<HistoryRow, 'quick_responses' | 'commands'> & {
  quick_responses: string | null;
  commands: string | null;
};

function decodeRow(row: DbHistoryRow): HistoryRow {
  return {
    ...row,
    quick_responses: decodeMetadata<XmppQuickResponse>(row.quick_responses),
    commands: decodeMetadata<XmppInlineCommand>(row.commands),
  };
}

function parseTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

async function cleanupMamShadowDuplicates(db: SQLite.SQLiteDatabase, windowSeconds = 30): Promise<void> {
  await db.runAsync(
    'DELETE FROM messages WHERE mam_id IS NULL AND EXISTS ('
      + 'SELECT 1 FROM messages archived '
      + 'WHERE archived.mam_id IS NOT NULL '
      + 'AND archived.bare_jid = messages.bare_jid '
      + 'AND archived.body = messages.body '
      + 'AND archived.direction = messages.direction '
      + 'AND ABS((julianday(archived.timestamp) - julianday(messages.timestamp)) * 86400.0) <= ?'
      + ')',
    [windowSeconds],
  );
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
    quickResponses: XmppQuickResponse[] | null = null,
    commands: XmppInlineCommand[] | null = null,
  ): Promise<boolean> {
    const db = await getDb();
    const result = await db.runAsync(
      'INSERT OR IGNORE INTO messages '
        + '(bare_jid, body, direction, timestamp, mam_id, quick_responses, commands) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        bareJid,
        body,
        direction,
        timestamp,
        mamId,
        encodeMetadata(quickResponses),
        encodeMetadata(commands),
      ],
    );
    if (result.changes === 0 && mamId && (quickResponses?.length || commands?.length)) {
      await db.runAsync(
        'UPDATE messages SET quick_responses = COALESCE(?, quick_responses), '
          + 'commands = COALESCE(?, commands) WHERE bare_jid = ? AND mam_id = ?',
        [encodeMetadata(quickResponses), encodeMetadata(commands), bareJid, mamId],
      );
    }
    return result.changes > 0;
  },

  /** Newest `limit` messages, returned oldest-first for rendering. */
  async getRecent(bareJid: string, limit = 50): Promise<HistoryRow[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<DbHistoryRow>(
      'SELECT body, direction, timestamp, mam_id, quick_responses, commands FROM ('
        + 'SELECT body, direction, timestamp, mam_id, quick_responses, commands FROM messages '
        + 'WHERE bare_jid = ? ORDER BY timestamp DESC LIMIT ?'
        + ') ORDER BY timestamp ASC',
      [bareJid, limit],
    );
    return rows.map(decodeRow);
  },

  /** The page of messages immediately older than `beforeTimestamp`. */
  async getBefore(bareJid: string, beforeTimestamp: string, limit = 50): Promise<HistoryRow[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<DbHistoryRow>(
      'SELECT body, direction, timestamp, mam_id, quick_responses, commands FROM ('
        + 'SELECT body, direction, timestamp, mam_id, quick_responses, commands FROM messages '
        + 'WHERE bare_jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?'
        + ') ORDER BY timestamp ASC',
      [bareJid, beforeTimestamp, limit],
    );
    return rows.map(decodeRow);
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

  /** Latest cached message for each requested conversation. */
  async getLatestForContacts(bareJids: string[]): Promise<HistoryPreviewRow[]> {
    const unique = [...new Set(bareJids.filter(Boolean))];
    if (unique.length === 0) return [];

    const db = await getDb();
    const placeholders = unique.map(() => '?').join(',');
    const rows = await db.getAllAsync<DbHistoryRow & { bare_jid: string }>(
      'SELECT m.bare_jid, m.body, m.direction, m.timestamp, m.mam_id, m.quick_responses, m.commands FROM messages m '
        + 'JOIN ('
        + 'SELECT bare_jid, MAX(timestamp) AS timestamp FROM messages '
        + `WHERE bare_jid IN (${placeholders}) GROUP BY bare_jid`
        + ') latest ON latest.bare_jid = m.bare_jid AND latest.timestamp = m.timestamp '
        + 'ORDER BY m.timestamp DESC',
      unique,
    );
    return rows.map((row) => ({ ...decodeRow(row), bare_jid: row.bare_jid }));
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
    quickResponses: XmppQuickResponse[] | null = null,
    commands: XmppInlineCommand[] | null = null,
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
          'UPDATE messages SET timestamp = ?, mam_id = ?, '
            + 'quick_responses = COALESCE(?, quick_responses), '
            + 'commands = COALESCE(?, commands) WHERE id = ?',
          [
            timestamp,
            mamId,
            encodeMetadata(quickResponses),
            encodeMetadata(commands),
            row.id,
          ],
        );
        return true;
      }
    }
    return false;
  },

  async quickResponseWasAnswered(timestamp: string, values: string[]): Promise<boolean> {
    const candidates = [...new Set(values.filter(Boolean))];
    if (candidates.length === 0) return false;
    const db = await getDb();
    const placeholders = candidates.map(() => '?').join(',');
    const row = await db.getFirstAsync<{ id: number }>(
      'SELECT id FROM messages WHERE direction = ? AND timestamp >= ? '
        + `AND body IN (${placeholders}) LIMIT 1`,
      ['out', timestamp, ...candidates],
    );
    return Boolean(row);
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
