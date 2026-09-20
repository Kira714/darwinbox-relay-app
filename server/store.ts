import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultConfiguration } from './presets.js';
import type { Run } from './types.js';

export class Store {
  db: DatabaseSync;
  constructor(public path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','ic')), password_hash TEXT NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS target_records (id TEXT PRIMARY KEY, data TEXT NOT NULL, version TEXT NOT NULL, owner TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS target_receipts (key TEXT PRIMARY KEY, run_id TEXT NOT NULL, record_id TEXT NOT NULL, previous TEXT, written_version TEXT NOT NULL, rolled_back INTEGER NOT NULL DEFAULT 0);`);
  }
  save(run: Run) {
    run.updatedAt = new Date().toISOString();
    run.revision = (run.revision || 0) + 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data',
        )
        .run(run.id, run.updatedAt, JSON.stringify(run));
      const stmt = this.db.prepare('INSERT OR IGNORE INTO audit VALUES (?, ?, ?)');
      for (const event of run.events) stmt.run(event.id, run.id, JSON.stringify(event));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  get(id: string): Run | undefined {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    return row ? hydrate(JSON.parse(String(row.data))) : undefined;
  }
  list(): Run[] {
    return this.db
      .prepare('SELECT data FROM runs ORDER BY updated_at DESC')
      .all()
      .map((r) => hydrate(JSON.parse(String(r.data))));
  }
  close() {
    this.db.close();
  }
}

/** Upgrades runs saved by earlier versions (fixed employee schema, MiniLM mapping). */
function hydrate(run: Run & { demo?: unknown; modelMode?: unknown }): Run {
  run.configuration ??= defaultConfiguration();
  delete run.demo;
  delete run.modelMode;
  for (const m of run.mappings as unknown as {
    method: string;
    candidates: { field: string; score?: number; confidence?: number }[];
  }[]) {
    if (m.method === 'model') m.method = 'ai';
    for (const c of m.candidates) c.confidence ??= c.score ?? 0;
  }
  return run;
}
