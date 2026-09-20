import express from 'express';
import multer from 'multer';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AiError, listFreeModels, openRouterClient, testClient, type AiClient } from './ai.js';
import { actor, admin, canRead, installAuth, type User } from './auth.js';
import {
  buildPayload,
  fieldNames,
  parseConfiguration,
  type Configuration,
} from './configuration.js';
import { deliver, rollback, type DeliveryContext } from './delivery.js';
import { audit, reconcile, resolveCase } from './engine.js';
import { escalate } from './escalation.js';
import { MAX_ROWS, parseFile } from './ingest.js';
import { mapSources } from './mapping.js';
import { normalizeSchemaInput } from './schemaInput.js';
import { defaultConfiguration, presets } from './presets.js';
import { Settings } from './settings.js';
import { Store } from './store.js';
import { chaos, listTarget, rollbackTarget, TargetError, writeTarget } from './target.js';
import type { Run, Source } from './types.js';

const decisionSchema = z
  .object({
    action: z.enum(['correct', 'approve', 'exclude', 'ignore', 'reject']),
    value: z.string().max(2000).optional(),
    reason: z.string().trim().min(8).max(1000),
  })
  .strict();

export function createApp(
  store: Store,
  targetUrl: () => string,
  options: { serviceToken?: string; ai?: () => AiClient | null } = {},
) {
  const serviceToken = options.serviceToken || randomBytes(32).toString('hex');
  const settings = new Settings(store.db, store.path === ':memory:' ? null : store.path);
  const aiClient = options.ai ?? (() => settings.aiClient());
  const ctx: DeliveryContext = { store, settings, targetUrl, serviceToken };

  const app = express();
  app.disable('x-powered-by');
  // Behind a hosting proxy the client address is in X-Forwarded-For (login throttling uses it).
  if (process.env.RENDER || process.env.TRUST_PROXY) app.set('trust proxy', 1);
  // Same-origin (or local development) requests only; state changes also need the CSRF token.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      try {
        const url = new URL(origin);
        if (
          url.host !== req.get('host') &&
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )
          return res.status(403).json({ error: 'Cross-origin requests are not accepted.' });
      } catch {
        return res.status(403).json({ error: 'Invalid origin.' });
      }
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  installAuth(app, store, serviceToken);
  app.use('/api/runs/:id', (req, _res, next) => {
    const run = store.get(String(req.params.id));
    if (!run || !canRead(actor(req), run))
      throw new TargetError(404, 'Migration not found or not assigned to you.');
    next();
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 10, fields: 6 },
  });
  const locks = new Set<string>();
  const requireRun = (id: string) => {
    const run = store.get(id);
    if (!run) throw new TargetError(404, 'Migration not found.');
    return run;
  };

  // ---- agent orchestration -------------------------------------------------------------
  async function deliverAndEscalate(run: Run) {
    await deliver(run, ctx);
    if (run.status === 'partial') await escalate(run, ctx, 'delivery');
  }
  async function processRun(run: Run) {
    run.status = 'mapping';
    store.save(run);
    await mapSources(run, aiClient());
    run.status = 'processing';
    store.save(run);
    reconcile(run);
    audit(
      run,
      run.cases.length ? 'Waiting for a person' : 'Validation passed',
      run.cases.length
        ? `${run.cases.length} case(s) need a human decision. Safe changes are already applied. Delivery is paused.`
        : 'Every record is valid. Starting autonomous delivery.',
    );
    store.save(run);
    if (run.cases.length) await escalate(run, ctx, 'review');
    else await deliverAndEscalate(run);
  }
  function schedule(id: string, work: (run: Run) => Promise<void>) {
    if (locks.has(id))
      throw new TargetError(409, 'The agent is already working on this migration.');
    locks.add(id);
    setImmediate(() => {
      void (async () => {
        const run = requireRun(id);
        try {
          await work(run);
        } catch (e) {
          run.status = 'error';
          run.error = e instanceof Error ? e.message : 'Unexpected error';
          audit(run, 'Agent stopped', run.error, { kind: 'system' });
          store.save(run);
          await escalate(run, ctx, 'error').catch(() => undefined);
        } finally {
          locks.delete(id);
        }
      })();
    });
  }
  function createRun(
    sources: Source[],
    user: User,
    assignedTo: string,
    name: string,
    configuration: Configuration,
    authorization?: string,
  ) {
    if (
      !sources.length ||
      sources.length > 20 ||
      sources.reduce((n, s) => n + s.rows.length, 0) > MAX_ROWS
    )
      throw new TargetError(
        400,
        `Upload 1–20 nonempty sources, at most ${MAX_ROWS} rows per migration.`,
      );
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      name,
      configuration,
      createdBy: user.id,
      assignedTo,
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      sources,
      mappings: [],
      records: [],
      cases: [],
      decisions: {},
      excludedSources: [],
      events: [],
    };
    if (authorization) settings.putSecret(`run-auth:${run.id}`, authorization);
    const target =
      configuration.destination.kind === 'http'
        ? new URL(configuration.destination.url).host
        : 'the built-in reference API';
    audit(
      run,
      'Source files received',
      `${sources.length} sources · ${sources.reduce((sum, s) => sum + s.rows.length, 0)} rows. Original values and row numbers retained.`,
    );
    audit(
      run,
      'Migration submitted',
      `${user.name} submitted the files for ${fieldNames(configuration).length} target fields, delivering to ${target}.`,
      {
        kind: 'human',
        actor: user,
        after: { assignedTo },
      },
    );
    store.save(run);
    schedule(run.id, processRun);
    return run;
  }

  // ---- reference data & settings -------------------------------------------------------
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/openapi.json', async (_req, res) =>
    res.type('application/json').send(await readFile(resolve('api/openapi.json'), 'utf8')),
  );
  app.get('/api/presets', (_req, res) => res.json(presets));
  app.get('/api/samples/:preset/:file', (req, res) => {
    // Only files listed on a preset are served; nothing else under samples/ is reachable.
    const preset = presets.find((p) => p.id === req.params.preset);
    const file = String(req.params.file);
    if (!preset || !preset.sample.files.includes(file))
      throw new TargetError(404, 'Sample file not found.');
    res.download(resolve('samples', preset.sample.folder, file), file);
  });
  /** Live check for the target-schema editor: normalizes whatever was typed and says what it understood. */
  app.post('/api/configuration/validate', admin, (req, res) => {
    const body = z
      .object({
        schema: z.union([
          z.string().max(60_000),
          z.record(z.string(), z.unknown()),
          z.array(z.unknown()),
        ]),
        identityField: z.string().max(120).optional(),
        fieldsOnly: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    try {
      const n = normalizeSchemaInput(body.schema, body.identityField, {
        fieldsOnly: body.fieldsOnly,
      });
      const props = n.schema.properties;
      res.json({
        ok: true,
        kind: n.kind,
        schema: n.schema,
        identityField: n.identityField,
        identityCandidates: n.identityCandidates,
        warnings: n.warnings,
        fields: Object.entries(props).map(([name, p]) => ({
          name,
          type: p.type,
          format: p.format,
          enum: p.enum,
          title: p.title,
          description: p.description,
          required: n.schema.required.includes(name),
          unique: !!p['x-unique'],
        })),
      });
    } catch (e) {
      res.json({ ok: false, error: e instanceof Error ? e.message : 'Could not read that.' });
    }
  });

  app.get('/api/settings', admin, (_req, res) => {
    const webhook = settings.webhook();
    res.json({
      ai: settings.publicAi(),
      escalationWebhook: {
        configured: !!webhook,
        host: webhook ? new URL(webhook).host : undefined,
      },
    });
  });
  app.put('/api/settings/ai', admin, (req, res) => {
    const body = z
      .object({
        model: z.string().regex(/^[\w.\-:/]{3,100}$/, 'Enter a model id such as vendor/model:free'),
        shareSamples: z.boolean(),
        minConfidence: z.number().min(0.5).max(0.99),
        apiKey: z.string().trim().min(10).max(300).optional(),
      })
      .strict()
      .parse(req.body);
    const { apiKey, ...rest } = body;
    settings.saveAi(rest, apiKey);
    res.json({ ai: settings.publicAi() });
  });
  app.delete('/api/settings/ai/key', admin, (_req, res) => {
    settings.clearAiKey();
    res.json({ ai: settings.publicAi() });
  });
  app.post('/api/settings/ai/test', admin, async (req, res) => {
    const body = z
      .object({
        model: z.string().max(100).optional(),
        apiKey: z.string().trim().min(10).max(300).optional(),
      })
      .strict()
      .parse(req.body);
    const client = body.apiKey
      ? openRouterClient(body.apiKey, {
          ...settings.ai(),
          ...(body.model && { model: body.model }),
        })
      : settings.aiClient(body.model ? { model: body.model } : {});
    if (!client) throw new TargetError(400, 'Add an OpenRouter API key first.');
    try {
      res.json({ ok: true, ...(await testClient(client, defaultConfiguration())) });
    } catch (e) {
      if (e instanceof AiError) throw new TargetError(400, e.message);
      throw e;
    }
  });
  app.get('/api/settings/ai/models', admin, async (_req, res) => {
    try {
      res.json({ models: await listFreeModels() });
    } catch (e) {
      res.json({ models: [], error: e instanceof Error ? e.message : 'Model list unavailable.' });
    }
  });
  app.put('/api/settings/escalation', admin, (req, res) => {
    const { webhookUrl } = z
      .object({ webhookUrl: z.union([z.literal(''), z.string().url().max(500)]) })
      .strict()
      .parse(req.body);
    if (!webhookUrl) settings.delete('escalation.webhook');
    else {
      if (!/^https?:$/.test(new URL(webhookUrl).protocol))
        throw new TargetError(400, 'Use an http(s) webhook URL.');
      settings.putSecret('escalation.webhook', webhookUrl);
    }
    res.json({ configured: !!webhookUrl, host: webhookUrl ? new URL(webhookUrl).host : undefined });
  });

  // ---- migrations ----------------------------------------------------------------------
  app.post('/api/sources/preview', admin, upload.array('files', 10), async (req, res) => {
    try {
      const sources: Source[] = [];
      for (const file of (req.files as Express.Multer.File[]) || [])
        sources.push(...(await parseFile(file.originalname, file.buffer)));
      res.json({
        sources: sources.map((s) => ({
          name: s.name,
          rows: s.rows.length,
          columns: s.headers.map((h) => ({
            name: h,
            sample: s.rows
              .slice(0, 3)
              .map((r) => r.values[h])
              .filter(Boolean),
          })),
        })),
      });
    } catch (e) {
      throw new TargetError(400, e instanceof Error ? e.message : 'Unable to read the files.');
    }
  });
  app.get('/api/runs', (req, res) =>
    res.json(
      store
        .list()
        .filter((r) => canRead(actor(req), r))
        .map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          createdAt: r.createdAt,
          records: r.records.length,
          pending: r.cases.length,
          assignedTo: r.assignedTo,
          assignee:
            store.db.prepare('SELECT name FROM users WHERE id=?').get(r.assignedTo || '')?.name ||
            'Unassigned',
        })),
    ),
  );
  app.get('/api/runs/:id', (req, res) => res.json(requireRun(String(req.params.id))));
  app.post('/api/runs', admin, upload.array('files', 10), async (req, res) => {
    const meta = z
      .object({
        name: z.string().trim().min(3).max(100),
        assignedTo: z.string(),
        configuration: z.string().max(60000).optional(),
        authorization: z.string().trim().max(500).optional(),
      })
      .strict()
      .parse(req.body);
    try {
      const files = req.files as Express.Multer.File[];
      if (!files?.length) throw new Error('Choose at least one CSV or Excel (.xlsx) file.');
      const sources: Source[] = [];
      for (const file of files) sources.push(...(await parseFile(file.originalname, file.buffer)));
      const configuration = meta.configuration
        ? parseConfiguration(JSON.parse(meta.configuration))
        : defaultConfiguration();
      if (meta.authorization && configuration.destination.kind === 'http')
        configuration.destination.hasAuth = true;
      if (
        !store.db
          .prepare("SELECT id FROM users WHERE id=? AND role='ic' AND active=1")
          .get(meta.assignedTo)
      )
        throw new Error('Assign an active implementation consultant to receive escalations.');
      const authorization =
        configuration.destination.kind === 'http' ? meta.authorization || undefined : undefined;
      res
        .status(202)
        .json(
          createRun(sources, actor(req), meta.assignedTo, meta.name, configuration, authorization),
        );
    } catch (e) {
      if (e instanceof TargetError) throw e;
      throw new TargetError(
        400,
        e instanceof z.ZodError
          ? e.issues.map((i) => i.message).join('; ')
          : e instanceof Error
            ? e.message
            : 'Unable to create the migration.',
      );
    }
  });
  app.post('/api/runs/:id/resolve', (req, res) => {
    if (locks.has(String(req.params.id)))
      throw new TargetError(409, 'The agent is still working. Please wait.');
    const body = z
      .object({
        caseId: z.string(),
        expectedRevision: z.number().int().nonnegative(),
        decision: decisionSchema,
      })
      .strict()
      .parse(req.body);
    const run = requireRun(String(req.params.id));
    if (body.expectedRevision !== (run.revision || 0))
      throw new TargetError(409, 'This migration changed. Refresh the case before deciding.');
    const hadMapping = run.cases.some((c) => c.kind === 'mapping');
    try {
      resolveCase(run, body.caseId, {
        ...body.decision,
        actor: actor(req),
        at: new Date().toISOString(),
      });
    } catch (e) {
      throw new TargetError(400, e instanceof Error ? e.message : 'Invalid decision.');
    }
    store.save(run);
    if (!run.cases.length) schedule(run.id, deliverAndEscalate);
    // Resolving the last column mapping can reveal record-level cases: tell the person.
    else if (hadMapping && !run.cases.some((c) => c.kind === 'mapping'))
      void escalate(run, ctx, 'review');
    res.json(run);
  });
  app.post('/api/runs/:id/retry', admin, (req, res) => {
    const run = requireRun(String(req.params.id));
    if (run.status !== 'partial')
      throw new TargetError(409, 'Only a migration with outstanding deliveries can be retried.');
    audit(
      run,
      'Delivery retry requested',
      `${actor(req).name} requested retry of outstanding records.`,
      { kind: 'human', actor: actor(req) },
    );
    store.save(run);
    schedule(run.id, deliverAndEscalate);
    res.status(202).json({ ok: true });
  });
  app.post('/api/runs/:id/resume', admin, (req, res) => {
    const run = requireRun(String(req.params.id));
    if (run.status !== 'error')
      throw new TargetError(409, 'Only interrupted migrations can be resumed.');
    audit(run, 'Migration resumed', `${actor(req).name} resumed interrupted processing.`, {
      kind: 'human',
      actor: actor(req),
    });
    delete run.error;
    store.save(run);
    schedule(run.id, run.records.some((r) => r.attempts > 0) ? deliverAndEscalate : processRun);
    res.status(202).json({ ok: true });
  });
  app.post('/api/runs/:id/rollback', admin, (req, res) => {
    const run = requireRun(String(req.params.id));
    if (run.configuration.destination.kind !== 'reference')
      throw new TargetError(
        409,
        'Rollback is only available for the built-in reference API. External targets support retry.',
      );
    if (!['completed', 'partial', 'rollback_conflict'].includes(run.status))
      throw new TargetError(409, 'Only a delivered migration can be rolled back.');
    audit(
      run,
      'Rollback requested',
      `${actor(req).name} requested restoration of this migration.`,
      { kind: 'human', actor: actor(req) },
    );
    store.save(run);
    schedule(run.id, (r) => rollback(r, ctx));
    res.status(202).json({ ok: true });
  });
  app.post('/api/runs/:id/assign', admin, (req, res) => {
    if (locks.has(String(req.params.id)))
      throw new TargetError(409, 'Wait for the active operation to finish.');
    const body = z
      .object({ assignedTo: z.string(), expectedRevision: z.number().int() })
      .strict()
      .parse(req.body);
    const run = requireRun(String(req.params.id));
    if (body.expectedRevision !== run.revision)
      throw new TargetError(409, 'Migration changed. Refresh and retry.');
    if (
      !store.db
        .prepare("SELECT id FROM users WHERE id=? AND role='ic' AND active=1")
        .get(body.assignedTo)
    )
      throw new TargetError(400, 'Choose an active implementation consultant.');
    audit(run, 'Consultant assigned', `${actor(req).name} updated the migration assignment.`, {
      kind: 'human',
      actor: actor(req),
      before: run.assignedTo,
      after: body.assignedTo,
    });
    run.assignedTo = body.assignedTo;
    store.save(run);
    res.json(run);
  });
  app.get('/api/runs/:id/summary', (req, res) => {
    const run = requireRun(String(req.params.id));
    res.json({
      id: run.id,
      status: run.status,
      sourceRows: run.sources.reduce((n, s) => n + s.rows.length, 0),
      records: run.records.length,
      pending: run.cases.length,
      rejected: run.records.filter((r) => r.state === 'excluded').length,
      delivered: run.records.filter((r) => r.state === 'delivered').length,
      failed: run.records.filter((r) => r.state === 'failed').length,
      automaticMappings: run.mappings.filter((m) => ['alias', 'ai'].includes(m.method)).length,
      humanDecisions: Object.keys(run.decisions).length,
      ai: run.ai,
      escalation: run.escalation,
      revision: run.revision,
    });
  });
  app.get('/api/runs/:id/audit', (req, res) => {
    const run = requireRun(String(req.params.id));
    res.attachment(`relay-${run.id}-audit.json`).json({
      runId: run.id,
      name: run.name,
      status: run.status,
      configuration: run.configuration,
      ai: run.ai,
      events: run.events,
      decisions: run.decisions,
      mappings: run.mappings,
    });
  });
  app.get('/api/runs/:id/payload', (req, res) => {
    const run = requireRun(String(req.params.id));
    if (run.cases.length)
      throw new TargetError(409, 'Resolve all review cases before exporting deliverable JSON.');
    res
      .attachment(`relay-${run.id}-payload.json`)
      .json(
        run.records
          .filter((r) => r.state !== 'excluded')
          .map((r) => buildPayload(run.configuration, r.data)),
      );
  });
  app.get('/api/runs/:id/export', (req, res) => {
    const run = requireRun(String(req.params.id));
    const fields = fieldNames(run.configuration);
    const escape = (v: string) => `"${(/^[=+@\-\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
    const csv = [
      fields.join(','),
      ...run.records
        .filter((r) => !['review', 'excluded'].includes(r.state))
        .map((r) => fields.map((f) => escape(r.data[f] || '')).join(',')),
    ].join('\r\n');
    res.attachment(`relay-${run.id}-cleaned.csv`).type('text/csv').send(csv);
  });

  // ---- built-in reference target (a stand-in for the customer's system) ------------------
  app.get('/api/mock/records', admin, (_req, res) => res.json(listTarget(store)));
  app.post('/api/mock/records', (req, res) => {
    const key = z.string().min(3).max(200).parse(req.get('idempotency-key'));
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    res.json(writeTarget(store, key, body));
  });
  app.post('/api/mock/rollback', (req, res) => {
    const body = z.object({ runId: z.string(), recordId: z.string() }).strict().parse(req.body);
    res.json(rollbackTarget(store, body.runId, body.recordId));
  });
  app.post('/api/mock/fail-next', admin, (req, res) => {
    const { count } = z
      .object({ count: z.number().int().min(1).max(10).default(1) })
      .strict()
      .parse(req.body ?? {});
    chaos.failNext = count;
    res.json({ failNext: chaos.failNext });
  });

  // ---- web app -------------------------------------------------------------------------
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint not found.' });
    res.sendFile(resolve('dist/index.html'), (error) => error && next(error));
  });
  app.use(
    (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status =
        error instanceof TargetError
          ? error.status
          : error instanceof z.ZodError || error instanceof multer.MulterError
            ? 400
            : 500;
      res.status(status).json({
        error:
          error instanceof z.ZodError
            ? error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')
            : status === 500
              ? 'Unexpected server error.'
              : error.message,
      });
    },
  );

  /** Marks work interrupted by a restart so nothing silently resumes or disappears. */
  function recover() {
    for (const run of store.list())
      if (['queued', 'mapping', 'processing', 'delivering', 'rolling_back'].includes(run.status)) {
        run.error =
          'The server restarted during processing. Resume delivery safely using idempotency, or retry rollback if restoration was interrupted.';
        run.status = run.status === 'rolling_back' ? 'rollback_conflict' : 'error';
        audit(run, 'Interrupted work recovered', run.error, { kind: 'system' });
        store.save(run);
      }
  }
  return { app, recover, settings };
}
