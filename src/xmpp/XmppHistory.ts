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
    stanza_id TEXT,
    oob_url TEXT,
    UNIQUE(bare_jid, mam_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(bare_jid, timestamp);
`;
// idx_messages_jid_stanza no va aquí: en una DB existente (creada antes de que
// stanza_id existiera), CREATE TABLE IF NOT EXISTS es un no-op sobre la tabla
// vieja, pero este CREATE INDEX igual correría contra ella y fallaría con
// "no such column: stanza_id" — la columna todavía no existe a esta altura,
// sólo después de que migrateMetadataColumns() la agregue más abajo, que es
// donde también se crea este índice.

export type Direction = 'in' | 'out';

export interface HistoryRow {
  body: string;
  direction: Direction;
  timestamp: string;
  mam_id: string | null;
  quick_responses: XmppQuickResponse[];
  commands: XmppInlineCommand[];
  stanza_id: string | null;
  /** Link del adjunto (XEP-0066 OOB), si el mensaje trae uno. */
  oob_url: string | null;
}

export interface HistoryPreviewRow extends HistoryRow {
  bare_jid: string;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    // Si open/migrate falla una vez, no dejar la promesa rota en caché para
    // siempre: cada llamada posterior volvería a fallar sin reintentar, y en
    // un build de release eso se ve como "el historial no carga" sin ningún
    // error visible. Limpiar dbPromise en el catch permite que la próxima
    // pantalla que abra un chat vuelva a intentarlo.
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await db.execAsync('PRAGMA journal_mode=WAL;');
      await db.execAsync(SCHEMA);
      await migrateMetadataColumns(db);
      return db;
    }).catch((error) => {
      dbPromise = null;
      throw error;
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
  if (!names.has('stanza_id')) {
    await db.execAsync('ALTER TABLE messages ADD COLUMN stanza_id TEXT');
    await db.execAsync(
      'CREATE INDEX IF NOT EXISTS idx_messages_jid_stanza ON messages(bare_jid, stanza_id)',
    );
    // Filas de antes de esta migración con quick_responses/commands
    // pendientes no tienen stanza_id para correlacionar con una futura
    // corrección XEP-0308 — darlas por resueltas de una vez, igual que
    // el cliente desktop (ver xmpp_history.py _migrate_db).
    await db.execAsync(
      'UPDATE messages SET quick_responses = NULL, commands = NULL '
        + 'WHERE stanza_id IS NULL '
        + 'AND (quick_responses IS NOT NULL OR commands IS NOT NULL)',
    );
  }
  // Link del adjunto entrante (XEP-0066 OOB). Sin esta columna el oobUrl que
  // ya parseaba XmppService se perdía al persistir y no se podía renderizar.
  if (!names.has('oob_url')) {
    await db.execAsync('ALTER TABLE messages ADD COLUMN oob_url TEXT');
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

type DbHistoryRow = Omit<HistoryRow, 'quick_responses' | 'commands' | 'stanza_id' | 'oob_url'> & {
  quick_responses: string | null;
  commands: string | null;
  stanza_id?: string | null;
  oob_url?: string | null;
};

function decodeRow(row: DbHistoryRow): HistoryRow {
  return {
    ...row,
    quick_responses: decodeMetadata<XmppQuickResponse>(row.quick_responses),
    commands: decodeMetadata<XmppInlineCommand>(row.commands),
    stanza_id: row.stanza_id ?? null,
    oob_url: row.oob_url ?? null,
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
    stanzaId: string | null = null,
    oobUrl: string | null = null,
  ): Promise<boolean> {
    const db = await getDb();
    const result = await db.runAsync(
      'INSERT OR IGNORE INTO messages '
        + '(bare_jid, body, direction, timestamp, mam_id, quick_responses, commands, stanza_id, oob_url) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        bareJid,
        body,
        direction,
        timestamp,
        mamId,
        encodeMetadata(quickResponses),
        encodeMetadata(commands),
        stanzaId,
        oobUrl,
      ],
    );
    if (result.changes === 0 && mamId && (quickResponses?.length || commands?.length)) {
      await db.runAsync(
        'UPDATE messages SET quick_responses = COALESCE(?, quick_responses), '
          + 'commands = COALESCE(?, commands), '
          + 'stanza_id = COALESCE(?, stanza_id) WHERE bare_jid = ? AND mam_id = ?',
        [
          encodeMetadata(quickResponses),
          encodeMetadata(commands),
          stanzaId,
          bareJid,
          mamId,
        ],
      );
    }
    return result.changes > 0;
  },

  /** Newest `limit` messages, returned oldest-first for rendering. */
  async getRecent(bareJid: string, limit = 50): Promise<HistoryRow[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<DbHistoryRow>(
      'SELECT body, direction, timestamp, mam_id, quick_responses, commands, stanza_id, oob_url FROM ('
        + 'SELECT body, direction, timestamp, mam_id, quick_responses, commands, stanza_id, oob_url FROM messages '
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
      'SELECT body, direction, timestamp, mam_id, quick_responses, commands, stanza_id, oob_url FROM ('
        + 'SELECT body, direction, timestamp, mam_id, quick_responses, commands, stanza_id, oob_url FROM messages '
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

  /**
   * Archive UID of the newest cached message that carries one — the RSM `after`
   * cursor for an incremental MAM catch-up. Ordered by timestamp (not rowid) so
   * a late-arriving older archive page can't shadow a genuinely newer message.
   */
  async getLatestMamId(bareJid: string): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ mam_id: string }>(
      'SELECT mam_id FROM messages WHERE bare_jid = ? AND mam_id IS NOT NULL '
        + 'ORDER BY timestamp DESC LIMIT 1',
      [bareJid],
    );
    return row?.mam_id ?? null;
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
    stanzaId: string | null = null,
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
            + 'commands = COALESCE(?, commands), '
            + 'stanza_id = COALESCE(?, stanza_id) WHERE id = ?',
          [
            timestamp,
            mamId,
            encodeMetadata(quickResponses),
            encodeMetadata(commands),
            stanzaId,
            row.id,
          ],
        );
        return true;
      }
    }
    return false;
  },

  /**
   * Clear quick_responses/commands for the question identified by
   * stanzaId without touching its body — used when a secondary sync
   * signal (own carbon) resolves the question before the authoritative
   * XEP-0308 correction (with its replacement text) arrives.
   */
  async markResolvedByStanzaId(bareJid: string, stanzaId: string): Promise<boolean> {
    const db = await getDb();
    const result = await db.runAsync(
      'UPDATE messages SET quick_responses = NULL, commands = NULL '
        + 'WHERE bare_jid = ? AND stanza_id = ?',
      [bareJid, stanzaId],
    );
    return result.changes > 0;
  },

  /**
   * Apply an incoming XEP-0308 correction to the question identified by
   * stanzaId: replaces the body and clears quick_responses/commands (now
   * resolved) so a later history restore doesn't show the card again.
   */
  async applyCorrectionByStanzaId(
    bareJid: string,
    stanzaId: string,
    body: string,
  ): Promise<boolean> {
    const db = await getDb();
    const result = await db.runAsync(
      'UPDATE messages SET body = ?, quick_responses = NULL, commands = NULL '
        + 'WHERE bare_jid = ? AND stanza_id = ?',
      [body, bareJid, stanzaId],
    );
    return result.changes > 0;
  },

  async quickResponseWasAnswered(
    bareJid: string,
    timestamp: string,
    values: string[],
  ): Promise<boolean> {
    const candidates = [...new Set(values.filter(Boolean))];
    if (candidates.length === 0) return false;
    const db = await getDb();
    const placeholders = candidates.map(() => '?').join(',');
    const row = await db.getFirstAsync<{ id: number }>(
      'SELECT id FROM messages WHERE bare_jid = ? AND direction = ? AND timestamp >= ? '
        + `AND body IN (${placeholders}) LIMIT 1`,
      [bareJid, 'out', timestamp, ...candidates],
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
