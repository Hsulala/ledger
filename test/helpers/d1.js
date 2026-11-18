// 測試用：用 node:sqlite 模擬 D1 與 R2 的介面（prepare/bind/all/first/run/batch；R2 的 get/put/delete）。
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const isRead = (sql) => /^\s*(select|with|pragma)\b/i.test(sql);

export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  class Stmt {
    constructor(sql) { this.sql = sql; this.params = []; }
    bind(...params) { this.params = params.map(norm); return this; }
    async all() { return this.allSync(); }
    allSync() {
      const results = db.prepare(this.sql).all(...this.params).map((r) => ({ ...r }));
      return { success: true, results, meta: { changes: 0 } };
    }
    async first(column) {
      const row = db.prepare(this.sql).get(...this.params);
      if (!row) return null;
      return column ? row[column] : { ...row };
    }
    async run() { return this.runSync(); }
    runSync() {
      const info = db.prepare(this.sql).run(...this.params);
      return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
  }

  return {
    raw: db,
    prepare: (sql) => new Stmt(sql),
    // 與 D1 相同：整批是一個交易，任何一句失敗整批 rollback
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => (isRead(s.sql) ? s.allSync() : s.runSync()));
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export function migrate(d1) {
  const dir = join(root, 'migrations');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) d1.raw.exec(readFileSync(join(dir, name), 'utf8'));
}

export function createR2() {
  const map = new Map();
  return {
    map,
    async put(key, body, options) { map.set(key, { body: new Uint8Array(body), contentType: options?.httpMetadata?.contentType ?? null }); },
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      return { body: new Blob([hit.body]).stream(), async arrayBuffer() { return hit.body.buffer.slice(hit.body.byteOffset, hit.body.byteOffset + hit.body.byteLength); }, httpMetadata: { contentType: hit.contentType } };
    },
    async delete(key) { map.delete(key); },
  };
}
