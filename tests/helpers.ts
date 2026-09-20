import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { AiClient, Suggestion } from '../server/ai.js';
import { seedUser } from '../server/auth.js';
import { defaultConfiguration } from '../server/presets.js';
import { parseFile } from '../server/ingest.js';
import { mapSources } from '../server/mapping.js';
import { reconcile } from '../server/engine.js';
import { Store } from '../server/store.js';
import type { Configuration } from '../server/configuration.js';
import type { Run, Source } from '../server/types.js';

export const PASSWORD = 'TestPassword!2026';

export function makeRun(
  sources: Source[],
  configuration: Configuration = defaultConfiguration(),
): Run {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: 'Test',
    configuration,
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
}

/** A canned AI client: answers by column name, or throws to simulate an outage. */
export function stubAi(
  answers: Record<string, Partial<Suggestion> & { target: string | null }> | Error,
  options: { minConfidence?: number; shareSamples?: boolean } = {},
): AiClient & { calls: { sourceName: string; columns: unknown[] }[] } {
  const calls: { sourceName: string; columns: unknown[] }[] = [];
  return {
    model: 'stub/model:free',
    shareSamples: options.shareSamples ?? false,
    minConfidence: options.minConfidence ?? 0.85,
    calls,
    async map({ sourceName, columns }) {
      calls.push({ sourceName, columns });
      if (answers instanceof Error) throw answers;
      return {
        servedBy: 'stub/model:free',
        suggestions: columns.flatMap(({ column }) => {
          const a = answers[column];
          return a
            ? [{ column, confidence: 0.95, reason: 'stub reasoning', alternatives: [], ...a }]
            : [];
        }),
      };
    },
  };
}

export async function csvRun(
  csv: string,
  ai: AiClient | null = null,
  configuration?: Configuration,
) {
  const run = makeRun(await parseFile('test.csv', Buffer.from(csv)), configuration);
  await mapSources(run, ai);
  reconcile(run);
  return run;
}

export async function scenario(folder: string, ai: AiClient | null = null) {
  const files = (await readdir(folder)).filter((f) => /\.(csv|xlsx)$/.test(f)).sort();
  const sources = (
    await Promise.all(files.map(async (f) => parseFile(f, await readFile(`${folder}/${f}`))))
  ).flat();
  const run = makeRun(sources);
  await mapSources(run, ai);
  reconcile(run);
  return run;
}

/** A tiny OpenRouter look-alike, so the real HTTP client is exercised end to end. */
export async function fakeOpenRouter(
  respond: (req: { model: string; body: Record<string, unknown>; count: number }) => {
    status?: number;
    body: unknown;
  },
) {
  const requests: { auth?: string; body: Record<string, unknown> }[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          data: [
            {
              id: 'vendor/free-a:free',
              name: 'Free A',
              context_length: 100000,
              pricing: { prompt: '0', completion: '0' },
              architecture: { output_modalities: ['text'] },
              supported_parameters: ['response_format'],
            },
            {
              id: 'vendor/paid-b',
              name: 'Paid B',
              context_length: 900000,
              pricing: { prompt: '0.001', completion: '0.002' },
              architecture: { output_modalities: ['text'] },
            },
          ],
        }),
      );
    }
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    requests.push({ auth: req.headers.authorization, body });
    const out = respond({ model: String(body.model), body, count: requests.length });
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
export const completion = (mappings: unknown[], model = 'fake/model:free') => ({
  model,
  choices: [{ message: { role: 'assistant', content: JSON.stringify({ mappings }) } }],
});

export async function startWorkspace(
  options: { ai?: () => AiClient | null; dbPath?: string } = {},
) {
  const store = new Store(options.dbPath ?? ':memory:');
  let base = '';
  const admin = await seedUser(store, 'admin@test.example', 'Admin', 'admin', PASSWORD);
  const ic = await seedUser(store, 'ic@test.example', 'Consultant', 'ic', PASSWORD);
  const other = await seedUser(store, 'other@test.example', 'Other consultant', 'ic', PASSWORD);
  const serviceToken = 'integration-service-token';
  const { app, settings } = createApp(store, () => base, { serviceToken, ai: options.ai });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = async (email: string) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { csrfToken: string };
    return { Cookie: r.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': body.csrfToken };
  };
  const adminHeaders = await login(admin.email);
  const icHeaders = await login(ic.email);
  const otherHeaders = await login(other.email);

  /** JSON request. Resolve calls get the current revision and a reason unless supplied. */
  const api = async (
    path: string,
    headers: Record<string, string> = adminHeaders,
    body?: unknown,
    method = body ? 'POST' : 'GET',
  ) => {
    if (path.endsWith('/resolve') && body) {
      const b = body as { expectedRevision?: number; decision: { reason?: string } };
      b.expectedRevision ??= store.get(path.split('/')[3])?.revision || 0;
      b.decision.reason ??= 'Confirmed by client for integration verification.';
    }
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  /** Multipart upload, exactly as the browser sends it. */
  const upload = async (input: {
    name?: string;
    files: Record<string, string | Buffer>;
    configuration?: unknown;
    authorization?: string;
    assignedTo?: string;
    path?: string;
  }) => {
    const form = new FormData();
    if (input.path !== '/api/sources/preview') {
      form.append('name', input.name ?? 'Test migration');
      form.append('assignedTo', input.assignedTo ?? ic.id);
      if (input.configuration) form.append('configuration', JSON.stringify(input.configuration));
      if (input.authorization) form.append('authorization', input.authorization);
    }
    for (const [name, content] of Object.entries(input.files))
      form.append('files', new Blob([content as BlobPart]), name);
    const r = await fetch(base + (input.path ?? '/api/runs'), {
      method: 'POST',
      body: form,
      headers: adminHeaders,
    });
    return { status: r.status, body: (await r.json()) as Run & { error?: string } };
  };
  const wait = async (id: string, states: string[]) => {
    for (let i = 0; i < 400; i++) {
      const run = store.get(id)!;
      if (states.includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out waiting for ${states}; run is ${store.get(id)?.status}`);
  };
  /** Wait until a run satisfies a condition (e.g. its escalation has been recorded). */
  const waitFor = async (id: string, done: (run: Run) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const run = store.get(id)!;
      if (done(run)) return run;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out waiting on run ${id} (status ${store.get(id)?.status})`);
  };
  const close = async () => {
    // Let any in-flight agent work settle before the database closes.
    for (
      let i = 0;
      i < 200 &&
      store
        .list()
        .some((r) =>
          ['queued', 'mapping', 'processing', 'delivering', 'rolling_back'].includes(r.status),
        );
      i++
    )
      await new Promise((r) => setTimeout(r, 15));
    await new Promise((r) => setTimeout(r, 30));
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  };
  return {
    store,
    settings,
    base,
    api,
    upload,
    wait,
    waitFor,
    close,
    admin,
    ic,
    other,
    adminHeaders,
    icHeaders,
    otherHeaders,
    login,
    serviceToken,
  };
}
export type Workspace = Awaited<ReturnType<typeof startWorkspace>>;

/** A JSON receiver standing in for the customer's HTTP API. */
export async function receiver(statusFor: (n: number) => number = () => 201) {
  const calls: { body: Record<string, unknown>; key?: string; auth?: string; service?: unknown }[] =
    [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({
      body: JSON.parse(raw),
      key: req.headers['idempotency-key'] as string,
      auth: req.headers.authorization,
      service: req.headers['x-relay-service'],
    });
    const status = statusFor(calls.length);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status >= 400 ? JSON.stringify({ error: 'target says no' }) : '{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/records`;
  return { url, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}
