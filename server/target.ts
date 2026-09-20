import { randomUUID } from 'node:crypto';
import { buildPayload, identityFields } from './configuration.js';
import type { Store } from './store.js';

export class TargetError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Relay's built-in reference target: a small versioned record store behind a plain
 * JSON API. It exists so a migration can be exercised end to end, including
 * idempotent retries and compare-before-restore rollback, without a live HR system.
 */
export const chaos = { failNext: 0 };

const parseKey = (key: string) => {
  const [runId, ...rest] = key.split(':');
  return { runId, recordId: rest.join(':') };
};

export function writeTarget(store: Store, key: string, body: Record<string, unknown>) {
  const { runId, recordId } = parseKey(key);
  const run = store.get(runId);
  const record = run?.records.find((r) => r.id === recordId);
  if (!run || !record || run.status !== 'delivering' || record.state === 'excluded')
    throw new TargetError(409, 'No authorized delivery for this run and record.');
  const cfg = run.configuration;
  if (JSON.stringify(buildPayload(cfg, record.data)) !== JSON.stringify(body))
    throw new TargetError(409, 'The payload differs from the approved record.');
  const id = String(body[cfg.identityField]);

  const receipt = store.db.prepare('SELECT * FROM target_receipts WHERE key=?').get(key);
  if (receipt) {
    if (receipt.rolled_back)
      throw new TargetError(409, 'This delivery was rolled back. Create a new migration.');
    return {
      id,
      version: receipt.written_version,
      idempotent: true,
      before: receipt.previous ? JSON.parse(JSON.parse(String(receipt.previous)).data) : null,
      after: body,
    };
  }
  if (chaos.failNext > 0) {
    chaos.failNext--;
    throw new TargetError(503, 'Simulated temporary target outage. Retry this record to recover.');
  }
  const existing = store.db.prepare('SELECT * FROM target_records WHERE id=?').get(id);
  for (const field of identityFields(cfg).filter((f) => f !== cfg.identityField)) {
    const clash = store.db
      .prepare('SELECT id FROM target_records WHERE json_extract(data, ?)=? AND id<>?')
      .get(`$.${field}`, body[field] as string, id);
    if (clash)
      throw new TargetError(
        409,
        `Target ${field} “${body[field]}” already belongs to record ${clash.id}.`,
      );
  }
  const version = randomUUID();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db
      .prepare('INSERT INTO target_receipts VALUES (?, ?, ?, ?, ?, 0)')
      .run(key, runId, id, existing ? JSON.stringify(existing) : null, version);
    store.db
      .prepare(
        'INSERT INTO target_records VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, version=excluded.version, owner=excluded.owner, updated_at=excluded.updated_at',
      )
      .run(id, JSON.stringify(body), version, runId, new Date().toISOString());
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return {
    id,
    version,
    idempotent: false,
    before: existing ? JSON.parse(String(existing.data)) : null,
    after: body,
  };
}

export function rollbackTarget(store: Store, runId: string, recordId: string) {
  const run = store.get(runId);
  if (!run || run.status !== 'rolling_back')
    throw new TargetError(409, 'This run is not authorized for rollback.');
  const key = `${runId}:${recordId}`;
  const receipt = store.db
    .prepare('SELECT * FROM target_receipts WHERE key=? AND run_id=?')
    .get(key, runId);
  if (!receipt) return { restored: false, message: 'No write receipt; target was not changed.' };
  if (receipt.rolled_back) return { restored: true, idempotent: true };
  const current = store.db
    .prepare('SELECT * FROM target_records WHERE id=?')
    .get(receipt.record_id!);
  if (!current || current.version !== receipt.written_version || current.owner !== runId)
    throw new TargetError(
      409,
      'Target changed after this migration. Rollback refused to preserve later work.',
    );
  const previous = receipt.previous ? JSON.parse(String(receipt.previous)) : null;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (previous)
      store.db
        .prepare('UPDATE target_records SET data=?, version=?, owner=?, updated_at=? WHERE id=?')
        .run(
          previous.data,
          previous.version,
          previous.owner,
          new Date().toISOString(),
          receipt.record_id!,
        );
    else store.db.prepare('DELETE FROM target_records WHERE id=?').run(receipt.record_id!);
    store.db.prepare('UPDATE target_receipts SET rolled_back=1 WHERE key=?').run(key);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return { restored: true, previous: previous ? JSON.parse(previous.data) : null };
}

export function listTarget(store: Store) {
  return store.db
    .prepare('SELECT * FROM target_records ORDER BY updated_at DESC')
    .all()
    .map((r) => ({
      ...JSON.parse(String(r.data)),
      _version: r.version,
      _run: r.owner,
      _at: r.updated_at,
    }));
}
