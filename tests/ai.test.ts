import test from 'node:test';
import assert from 'node:assert/strict';
import { AiError, listFreeModels, openRouterClient, parseSuggestions } from '../server/ai.js';
import { defaultConfiguration } from '../server/presets.js';
import { completion, csvRun, fakeOpenRouter, scenario, startWorkspace, stubAi } from './helpers.js';

process.env.RELAY_AI_RETRY_MS = '5';
const RAW = 'ada.lovelace@example.com';
const HEADER = 'Emp Code,Nombre completo,E-mail (work),Org Unit,Favourite Colour';
const ROW = `HX-1,Ada Lovelace,${RAW},Engineering,Teal`;

test('model output is parsed defensively: fences, percentages, "null" targets and junk are handled', () => {
  const [a, b] = parseSuggestions(
    '```json\n{"mappings":[{"column":"A","target":"email","confidence":92,"reason":"r"},{"column":"B","target":"none","confidence":"0.4"}]}\n```',
  );
  assert.equal(a.confidence, 0.92);
  assert.equal(b.target, null);
  assert.equal(b.confidence, 0.4);
  assert.throws(() => parseSuggestions('sorry, I cannot'), AiError);
  assert.throws(() => parseSuggestions('{"mappings":[{"column":1}]}'), /unexpected shape/);
});

test('confident, type-compatible proposals are applied; the rest are escalated with the AI reasoning', async () => {
  const ai = stubAi({
    'Emp Code': { target: 'employee_id', confidence: 0.97 },
    'Nombre completo': { target: 'full_name', confidence: 0.99 },
    'E-mail (work)': { target: 'email', confidence: 0.99 },
    'Org Unit': { target: 'department', confidence: 0.6, reason: 'could be a cost centre' },
    'Favourite Colour': { target: null, confidence: 0.98 },
  });
  const run = await csvRun(`${HEADER}\n${ROW}`, ai);
  const by = (c: string) => run.mappings.find((m) => m.column === c)!;
  assert.deepEqual([by('Emp Code').method, by('Emp Code').target], ['ai', 'employee_id']);
  assert.equal(by('E-mail (work)').target, 'email');
  assert.equal(
    by('Favourite Colour').method,
    'ignored',
    'confidently irrelevant columns are dropped, visibly',
  );
  assert.equal(by('Org Unit').method, 'pending');
  assert.match(by('Org Unit').reason, /60%.*cost centre/);
  assert.equal(run.cases.length, 1);
  assert.equal(run.status, 'review');
  assert.equal(run.ai?.status, 'used');
  assert.equal(run.ai?.columnsSent, 5);
  // Privacy: only headers + shapes were sent, never the raw cell values.
  const wire = JSON.stringify(ai.calls);
  assert.ok(
    !wire.includes(RAW) && !wire.includes('Ada'),
    'raw values must not reach the provider by default',
  );
  assert.match(wire, /"kind":"email"/);
});

test('safety net: collisions, wrong formats, unknown fields and hallucinated columns never auto-apply', async () => {
  const ai = stubAi({
    'Emp Code': { target: 'employee_id' },
    'Nombre completo': { target: 'employee_id' }, // collides with Emp Code
    'E-mail (work)': { target: 'start_date' }, // values are not dates
    'Org Unit': { target: 'salary' }, // not a field of this schema
  });
  const run = await csvRun(`${HEADER}\n${ROW}`, ai);
  const by = (c: string) => run.mappings.find((m) => m.column === c)!;
  assert.equal(by('Emp Code').method, 'ai');
  assert.match(by('Nombre completo').reason, /already maps there/);
  assert.match(by('E-mail (work)').reason, /do not fit/);
  assert.match(by('Org Unit').reason, /not a field/);
  assert.equal(
    by('Favourite Colour').method,
    'pending',
    'no answer for a column means a person decides',
  );
  assert.equal(run.cases.filter((c) => c.kind === 'mapping').length, 4);
});

test('an unfamiliar column with dates in two conventions maps as a date without escalating the mapping', async () => {
  const ai = stubAi({ Onboarded: { target: 'start_date' } });
  const run = await csvRun(
    'Staff ID,Full Name,Work Email,Onboarded\nS1,Ada One,a@example.com,04/05/2024',
    ai,
  );
  assert.equal(run.mappings.find((m) => m.column === 'Onboarded')!.method, 'ai');
  assert.deepEqual(
    run.cases.map((c) => c.kind),
    ['date'],
  );
});

test('AI outage: nothing is guessed, the failure is recorded, and every unfamiliar column escalates', async () => {
  const run = await csvRun(
    `${HEADER}\n${ROW}`,
    stubAi(new AiError('AI provider returned 401: invalid key', false, 401)),
  );
  assert.equal(run.ai?.status, 'failed');
  assert.match(run.ai!.error!, /401/);
  assert.equal(run.mappings.filter((m) => m.method === 'pending').length, 5);
  assert.ok(run.events.some((e) => e.title === 'AI mapping unavailable'));
});

test('without an AI key the agent still handles known aliases and escalates the rest', async () => {
  const run = await csvRun('Staff ID,Full Name,Work Email,Org Unit\nS1,Ada One,a@example.com,Eng');
  assert.equal(run.ai?.status, 'not_configured');
  assert.deepEqual(
    run.mappings.map((m) => m.method),
    ['alias', 'alias', 'alias', 'pending'],
  );
  assert.match(run.mappings[3].reason, /not configured/);
});

test('a required field with no source is not silently lost to an auto-ignore', async () => {
  const ai = stubAi({ Mail: { target: null, confidence: 0.95, alternatives: ['email'] } });
  const run = await csvRun('Staff ID,Full Name,Mail\nS1,Ada One,a@example.com', ai);
  assert.equal(run.mappings.find((m) => m.column === 'Mail')!.method, 'pending');
  assert.match(run.mappings.find((m) => m.column === 'Mail')!.reason, /Required field “email”/);
});

test('sample values are shared only when the operator opts in', async () => {
  const ai = stubAi({ 'Org Unit': { target: 'department' } }, { shareSamples: true });
  await csvRun(
    'Staff ID,Full Name,Work Email,Org Unit\nS1,Ada One,a@example.com,Engineering\nS2,Bo Two,b@example.com,Sales',
    ai,
  );
  assert.match(JSON.stringify(ai.calls), /Engineering/);
});

test('helix Excel scenario: with the expected AI answers exactly three business decisions remain', async () => {
  const ai = stubAi({
    'Emp Code': { target: 'employee_id' },
    'Personnel No.': { target: 'employee_id' },
    'Nombre completo': { target: 'full_name' },
    'E-mail (work)': { target: 'email' },
    Mail: { target: 'email' },
    'Org Unit': { target: 'department' },
    'Position Held': { target: 'job_title' },
    'Onboarding Date': { target: 'start_date' },
    'Joined On': { target: 'start_date' },
    'Emp Status': { target: 'employment_status' },
    'Favourite Colour': { target: null },
    'Manager Name': { target: null },
  });
  const run = await scenario('samples/04-helix', ai);
  assert.equal(ai.calls.length, 2, 'one AI call per source file');
  assert.equal(run.records.length, 10);
  assert.deepEqual(run.cases.map((c) => c.kind).sort(), ['conflict', 'date', 'validation']);
  assert.equal(
    run.records.find((r) => r.data.employee_id === 'HX-105')!.data.employment_status,
    'inactive',
  );
  assert.equal(run.records.find((r) => r.data.employee_id === 'HX-101')!.lineage.length, 2);
});

test('OpenRouter client: sends the key and JSON mode, retries a rate limit, then falls back to the router', async () => {
  const seen: string[] = [];
  const fake = await fakeOpenRouter(({ model }) => {
    seen.push(model);
    return model === 'vendor/flaky:free'
      ? {
          status: 429,
          body: {
            error: {
              message: 'Provider returned error',
              code: 429,
              metadata: { raw: 'rate-limited upstream' },
            },
          },
        }
      : {
          body: completion(
            [{ column: 'E-mail (work)', target: 'email', confidence: 0.9, reason: 'email' }],
            'router/picked:free',
          ),
        };
  });
  process.env.OPENROUTER_BASE_URL = fake.url;
  try {
    const client = openRouterClient('sk-or-test-key', { model: 'vendor/flaky:free' });
    const out = await client.map({
      config: defaultConfiguration(),
      sourceName: 'f.csv',
      columns: [],
    });
    assert.deepEqual(seen, ['vendor/flaky:free', 'vendor/flaky:free', 'openrouter/free']);
    assert.equal(out.servedBy, 'router/picked:free');
    assert.equal(out.suggestions[0].target, 'email');
    assert.equal(fake.requests[0].auth, 'Bearer sk-or-test-key');
    assert.deepEqual(fake.requests[0].body.response_format, { type: 'json_object' });
    assert.equal(fake.requests[0].body.temperature, 0);
  } finally {
    await fake.close();
  }
});

test('OpenRouter client: a rejected key stops immediately and the error never contains the key', async () => {
  const fake = await fakeOpenRouter(() => ({
    status: 401,
    body: { error: { message: 'No auth credentials found', code: 401 } },
  }));
  process.env.OPENROUTER_BASE_URL = fake.url;
  try {
    const client = openRouterClient('sk-or-secret-value-123');
    await assert.rejects(
      client.map({ config: defaultConfiguration(), sourceName: 'f.csv', columns: [] }),
      (e: AiError) => {
        assert.equal(e.status, 401);
        assert.ok(!e.message.includes('sk-or-secret-value-123'));
        return true;
      },
    );
    assert.equal(fake.requests.length, 1, 'no retry or fallback after a credential failure');
  } finally {
    await fake.close();
  }
});

test('OpenRouter client: unparseable answers are retried, then reported', async () => {
  const fake = await fakeOpenRouter(() => ({
    body: { model: 'm', choices: [{ message: { content: 'I think email.' } }] },
  }));
  process.env.OPENROUTER_BASE_URL = fake.url;
  try {
    await assert.rejects(
      openRouterClient('k').map({
        config: defaultConfiguration(),
        sourceName: 'f.csv',
        columns: [],
      }),
      /did not return JSON/,
    );
    assert.equal(
      fake.requests.length,
      4,
      'two attempts on the chosen model and two on the fallback',
    );
  } finally {
    await fake.close();
  }
});

test('free model list keeps only zero-price text models', async () => {
  const fake = await fakeOpenRouter(() => ({ body: {} }));
  process.env.OPENROUTER_BASE_URL = fake.url;
  try {
    assert.deepEqual(
      (await listFreeModels()).map((m) => m.id),
      ['vendor/free-a:free'],
    );
  } finally {
    await fake.close();
  }
});

test('settings API: the key is write-only, encrypted at rest, admin-only and testable before saving', async () => {
  const fake = await fakeOpenRouter(({ model }) => ({
    body: completion(
      [{ column: 'E-mail (work)', target: 'email', confidence: 0.99, reason: 'email' }],
      model,
    ),
  }));
  process.env.OPENROUTER_BASE_URL = fake.url;
  const s = await startWorkspace();
  const KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789';
  try {
    assert.equal((await s.api('/api/settings', s.icHeaders)).status, 403);
    assert.equal(
      (await s.api('/api/settings/ai/test', s.adminHeaders, {})).status,
      400,
      'no key yet',
    );
    const tested = await s.api('/api/settings/ai/test', s.adminHeaders, {
      apiKey: KEY,
      model: 'vendor/free-a:free',
    });
    assert.equal(tested.status, 200);
    assert.equal(fake.requests[0].auth, `Bearer ${KEY}`);
    assert.equal((await s.api('/api/settings')).body.ai.configured, false, 'testing does not save');

    const saved = await s.api(
      '/api/settings/ai',
      s.adminHeaders,
      { model: 'vendor/free-a:free', shareSamples: false, minConfidence: 0.9, apiKey: KEY },
      'PUT',
    );
    assert.equal(saved.status, 200);
    const shown = JSON.stringify((await s.api('/api/settings')).body);
    assert.ok(
      !shown.includes(KEY) && shown.includes('…6789') && shown.includes('"configured":true'),
    );
    const stored = JSON.stringify(s.store.db.prepare('SELECT * FROM settings').all());
    assert.ok(
      !stored.includes(KEY) && !stored.includes('abcdefghij'),
      'plaintext key must not be stored',
    );
    assert.equal(s.settings.apiKey()?.key, KEY);

    // Updating options without re-sending the key keeps the saved key.
    await s.api(
      '/api/settings/ai',
      s.adminHeaders,
      { model: 'vendor/free-a:free', shareSamples: true, minConfidence: 0.8 },
      'PUT',
    );
    assert.equal(s.settings.apiKey()?.key, KEY);
    assert.equal((await s.api('/api/settings')).body.ai.shareSamples, true);
    assert.equal((await s.api('/api/settings/ai/models')).body.models[0].id, 'vendor/free-a:free');
    assert.equal(
      (await s.api('/api/settings/ai/key', s.adminHeaders, undefined, 'DELETE')).body.ai.configured,
      false,
    );
  } finally {
    await s.close();
    await fake.close();
  }
});
