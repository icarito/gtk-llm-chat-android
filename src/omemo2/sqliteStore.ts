// OmemoStore sobre expo-sqlite con cifrado en reposo: cada valor se guarda como
// base64(nonce || AES-256-GCM(valor)) con la clave de la fila como AAD (no se
// puede mover un valor a otra clave). La clave de 32 bytes vive en
// expo-secure-store (el límite de ~2KB de SecureStore descarta guardar ahí el estado).
import { gcm } from '@noble/ciphers/aes';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { bytesToHex, fromUtf8, hexToBytes, randomBytes, utf8 } from './bytes';
import { b64decode, b64encode } from './base64';
import type { OmemoStore } from './store';

const DB_NAME = 'omemo2.db';
const KEY_NAME = 'omemo2_db_key';

async function loadDbKey(): Promise<Uint8Array> {
  const hex = await SecureStore.getItemAsync(KEY_NAME);
  if (hex && hex.length === 64) return hexToBytes(hex);
  const key = randomBytes(32);
  await SecureStore.setItemAsync(KEY_NAME, bytesToHex(key));
  return key;
}

export class SqliteOmemoStore implements OmemoStore {
  private ready: Promise<{ db: SQLite.SQLiteDatabase; key: Uint8Array }> | null = null;

  private open() {
    if (!this.ready) {
      this.ready = (async () => {
        const db = await SQLite.openDatabaseAsync(DB_NAME);
        await db.execAsync('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);');
        return { db, key: await loadDbKey() };
      })().catch((e) => {
        this.ready = null; // permitir reintento
        throw e;
      });
    }
    return this.ready;
  }

  async get(key: string): Promise<string | null> {
    const { db, key: k } = await this.open();
    const row = await db.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', key);
    if (!row) return null;
    const raw = b64decode(row.v);
    return fromUtf8(gcm(k, raw.subarray(0, 12), utf8(key)).decrypt(raw.subarray(12)));
  }

  async set(key: string, value: string): Promise<void> {
    const { db, key: k } = await this.open();
    const nonce = randomBytes(12);
    const ct = gcm(k, nonce, utf8(key)).encrypt(utf8(value));
    const out = new Uint8Array(12 + ct.length);
    out.set(nonce);
    out.set(ct, 12);
    await db.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', key, b64encode(out));
  }

  async remove(key: string): Promise<void> {
    const { db } = await this.open();
    await db.runAsync('DELETE FROM kv WHERE k = ?', key);
  }
}
