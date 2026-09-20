import { buildPayload } from './configuration.js';
import { audit } from './engine.js';
import type { Settings } from './settings.js';
import type { Store } from './store.js';
import type { Run } from './types.js';

export interface DeliveryContext {
  store: Store;
  settings: Settings;
  /** Base URL of this server, used for the built-in reference target. */
  targetUrl: () => string;
  /** Credential that authorizes Relay (and only Relay) to call the reference target. */
  serviceToken: string;
}

/** Stop after this many consecutive failures instead of hammering a broken target. */
const CIRCUIT_BREAKER = 3;

const messageOf = (body: unknown, fallback: string) => {
  const err =
    (body as { error?: unknown; message?: unknown } | null)?.error ??
    (body as { message?: unknown } | null)?.message;
  return typeof err === 'string' ? err : fallback;
};

export async function deliver(run: Run, ctx: DeliveryContext) {
  const cfg = run.configuration;
  if (run.cases.length) throw new Error('Resolve all review cases before delivery.');
  // Every record is validated against the schema before the first request, so a schema
  // problem can never produce a half-delivered batch.
  for (const row of run.records.filter((r) => r.state !== 'excluded')) buildPayload(cfg, row.data);
  run.status = 'delivering';
  delete run.escalation;
  ctx.store.save(run);

  const dest = cfg.destination;
  const reference = dest.kind === 'reference';
  const url = dest.kind === 'http' ? dest.url : `${ctx.targetUrl()}/api/mock/records`;
  const authorization =
    dest.kind === 'http' && dest.hasAuth ? ctx.settings.getSecret(`run-auth:${run.id}`) : undefined;
  const label = reference ? 'reference target' : new URL(url).host;

  let streak = 0;
  for (const row of run.records.filter((r) => ['ready', 'failed'].includes(r.state))) {
    row.attempts++;
    const payload = buildPayload(cfg, row.data);
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `${run.id}:${row.id}`,
          ...(reference ? { 'x-relay-service': ctx.serviceToken } : {}),
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      let body: { before?: unknown } | null = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* external targets may answer with plain text */
      }
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${messageOf(body, response.statusText)}`);
      row.state = 'delivered';
      delete row.error;
      streak = 0;
      audit(
        run,
        'Record delivered',
        `${row.data[cfg.identityField]} → ${label}. Attempt ${row.attempts}; idempotency key ${run.id.slice(0, 8)}:${row.id.slice(-6)} sent.`,
        { kind: 'integration', recordId: row.id, before: body?.before, after: payload },
      );
    } catch (error) {
      row.state = 'failed';
      row.error = error instanceof Error ? error.message : 'Delivery failed';
      streak++;
      audit(run, 'Delivery needs retry', `${row.data[cfg.identityField]}: ${row.error}`, {
        kind: 'integration',
        recordId: row.id,
      });
    }
    ctx.store.save(run);
    if (streak >= CIRCUIT_BREAKER) {
      audit(
        run,
        'Delivery paused',
        `${CIRCUIT_BREAKER} consecutive requests failed, so the agent stopped instead of retrying blindly. Remaining records were not sent.`,
        { kind: 'integration' },
      );
      break;
    }
  }
  const outstanding = run.records.filter((r) => ['ready', 'failed'].includes(r.state));
  run.status = outstanding.length ? 'partial' : 'completed';
  const count = (state: string) => run.records.filter((r) => r.state === state).length;
  audit(
    run,
    run.status === 'completed' ? 'Migration complete' : 'Migration partially delivered',
    `${count('delivered')} delivered; ${outstanding.length} outstanding; ${count('excluded')} rejected.`,
  );
  ctx.store.save(run);
}

/** Restores the reference target. Arbitrary HTTP targets have no undo contract, so they only support retry. */
export async function rollback(run: Run, ctx: DeliveryContext) {
  run.status = 'rolling_back';
  ctx.store.save(run);
  // Include failed writes: a response can be lost after the target commits.
  for (const row of run.records.filter((r) =>
    ['delivered', 'failed', 'rollback_conflict'].includes(r.state),
  )) {
    try {
      const response = await fetch(`${ctx.targetUrl()}/api/mock/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-service': ctx.serviceToken },
        body: JSON.stringify({ runId: run.id, recordId: row.id }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(messageOf(body, 'Rollback failed'));
      row.state = 'rolled_back';
      delete row.error;
      audit(
        run,
        'Target change rolled back',
        `${row.data[run.configuration.identityField]}: previous state restored, or no write was made.`,
        {
          kind: 'integration',
          recordId: row.id,
          after: body,
        },
      );
    } catch (e) {
      row.state = 'rollback_conflict';
      row.error = e instanceof Error ? e.message : 'Rollback failed';
      audit(
        run,
        'Rollback could not complete',
        `${row.data[run.configuration.identityField]}: ${row.error}`,
        {
          kind: 'integration',
          recordId: row.id,
        },
      );
    }
    ctx.store.save(run);
  }
  run.status = run.records.some((r) => r.state === 'rollback_conflict')
    ? 'rollback_conflict'
    : 'rolled_back';
  ctx.store.save(run);
}
