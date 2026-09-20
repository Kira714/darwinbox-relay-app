import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { defaultConfiguration } from '../server/presets.js';
import { Store } from '../server/store.js';
import type { Run } from '../server/types.js';
import { receiver, startWorkspace, stubAi, type Workspace } from './helpers.js';

const files = async (folder: string, names: string[]) =>
  Object.fromEntries(
    await Promise.all(names.map(async (n) => [n, await readFile(`samples/${folder}/${n}`)])),
  );
const meridian = () => files('01-meridian', ['company-directory.csv', 'hr-master.csv']);
const northstar = () => files('02-northstar', ['acquired-directory.csv', 'hr-export.csv']);
const helix = () => files('04-helix', ['hr-core.xlsx', 'legacy-crm.xlsx']);
const targetRows = async (s: Workspace) =>
  (await s.api('/api/mock/records')).body as { employee_id: string; _run: string }[];

async function answerReviews(s: Workspace, id: string, answers: Record<string, string>) {
  let run = await s.wait(id, ['review']);
  while (run.cases.length) {
    const c = run.cases[0];
    const res = await s.api(`/api/runs/${id}/resolve`, s.icHeaders, {
      caseId: c.id,
      decision: { action: 'correct', value: answers[c.field!] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    run = res.body;
  }
  return run;
}

test('clean files: the agent maps, cleans, reconciles and delivers with nobody in the loop', async () => {
  const s = await startWorkspace();
  try {
    const created = await s.upload({ files: await meridian() });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const run = await s.wait(created.body.id, ['completed']);
    assert.equal(run.cases.length, 0);
    assert.equal(run.escalation, undefined);
    assert.equal(run.records.filter((r) => r.state === 'delivered').length, 8);
    const rows = await targetRows(s);
    assert.equal(rows.length, 8);
    const kabir = rows.find((r) => r.employee_id === 'MR-002') as Record<string, unknown>;
    assert.equal(kabir.start_date, '2024-03-18', '18/03/2024 was safely normalized');
    assert.equal(kabir.email, 'kabir.shah@example.com');
    assert.ok(run.events.some((e) => e.title === 'Record delivered'));
    assert.deepEqual(
      (await s.api(`/api/runs/${run.id}/summary`, s.icHeaders)).body.ai.status,
      'not_configured',
    );
  } finally {
    await s.close();
  }
});

test('ambiguity blocks delivery, escalates to the assigned consultant with reasons, and resumes after their decisions', async () => {
  const hook = await receiver();
  const s = await startWorkspace();
  try {
    await s.api('/api/settings/escalation', s.adminHeaders, { webhookUrl: hook.url }, 'PUT');
    const created = await s.upload({ name: 'Northstar acquisition', files: await northstar() });
    await s.wait(created.body.id, ['review']);
    const run = await s.waitFor(created.body.id, (r) => !!r.escalation?.webhook);
    assert.equal(run.cases.length, 3);
    assert.equal(
      (await targetRows(s)).length,
      0,
      'nothing reaches the target while a decision is pending',
    );
    assert.match(run.escalation!.headline, /3 decisions needed/);
    assert.equal(run.escalation!.assignee, 'Consultant');
    assert.equal(run.escalation!.webhook, 'sent');
    assert.match(String((hook.calls[0].body as { text: string }).text), /Northstar acquisition/);
    assert.ok(run.events.some((e) => e.title === 'Escalated to Consultant'));
    // Only the assigned consultant can act; the invalid answer is refused with a reason.
    assert.equal(
      (
        await s.api(`/api/runs/${run.id}/resolve`, s.otherHeaders, {
          caseId: run.cases[0].id,
          decision: { action: 'correct', value: 'x' },
        })
      ).status,
      404,
    );
    const bad = await s.api(`/api/runs/${run.id}/resolve`, s.icHeaders, {
      caseId: run.cases.find((c) => c.field === 'email')!.id,
      decision: { action: 'correct', value: 'not-an-email' },
    });
    assert.equal(bad.status, 400);
    await answerReviews(s, run.id, {
      start_date: '2024-05-04',
      department: 'People',
      email: 'lucas.reed@example.com',
    });
    const done = await s.wait(run.id, ['completed']);
    assert.equal(done.records.filter((r) => r.state === 'delivered').length, 6);
    assert.equal(done.escalation, undefined);
    assert.equal(
      Object.values(done.decisions).every((d) => d.actor?.id === s.ic.id),
      true,
      'actor is server-owned',
    );
  } finally {
    await s.close();
    await hook.close();
  }
});

test('AI + Excel end to end: unfamiliar headers are mapped by the model, then three real decisions are escalated', async () => {
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
  const s = await startWorkspace({ ai: () => ai });
  try {
    const created = await s.upload({ name: 'Helix consolidation', files: await helix() });
    const run = await s.wait(created.body.id, ['review']);
    assert.equal(run.ai?.status, 'used');
    assert.equal(run.mappings.filter((m) => m.method === 'ai').length, 10);
    assert.equal(run.mappings.filter((m) => m.method === 'ignored').length, 2);
    assert.deepEqual(run.cases.map((c) => c.kind).sort(), ['conflict', 'date', 'validation']);
    await answerReviews(s, run.id, {
      start_date: '2024-05-04',
      department: 'Operations',
      email: 'omar.haddad@example.com',
    });
    const done = await s.wait(run.id, ['completed']);
    assert.equal((await targetRows(s)).length, 10);
    const summary = (await s.api(`/api/runs/${done.id}/summary`)).body;
    assert.equal(summary.automaticMappings, 13, '3 known aliases + 10 AI mappings');
    assert.equal(summary.humanDecisions, 3);
  } finally {
    await s.close();
  }
});

test('AI failure is surfaced to the person as the reason for escalation, not hidden', async () => {
  const s = await startWorkspace({
    ai: () => stubAi(new Error('AI provider returned 401: bad key')),
  });
  try {
    const created = await s.upload({ files: await helix() });
    await s.wait(created.body.id, ['review']);
    const run = await s.waitFor(created.body.id, (r) => !!r.escalation?.assignee);
    assert.equal(run.ai?.status, 'failed');
    assert.match(run.escalation!.items[0], /AI mapping was unavailable.*401/);
    assert.ok(
      run.cases.every((c) => c.kind === 'mapping'),
      'no record is interpreted before its columns are placed',
    );
    assert.equal((await targetRows(s)).length, 0);
  } finally {
    await s.close();
  }
});

test('target outage: failed records are flagged and escalated, retry is idempotent, and rollback restores', async () => {
  const s = await startWorkspace();
  try {
    assert.equal((await s.api('/api/mock/fail-next', s.icHeaders, { count: 1 })).status, 403);
    assert.equal((await s.api('/api/mock/fail-next', s.adminHeaders, { count: 1 })).status, 200);
    const created = await s.upload({ files: await meridian() });
    await s.wait(created.body.id, ['partial']);
    let run = await s.waitFor(created.body.id, (r) => !!r.escalation);
    assert.equal(run.records.filter((r) => r.state === 'failed').length, 1);
    assert.equal(run.records.filter((r) => r.state === 'delivered').length, 7);
    assert.match(run.escalation!.headline, /1 of 8 records could not be delivered/);
    assert.match(run.escalation!.items[0], /503/);
    assert.equal(
      (await s.api(`/api/runs/${run.id}/retry`, s.icHeaders, {})).status,
      403,
      'consultants cannot retry',
    );
    assert.equal((await s.api(`/api/runs/${run.id}/retry`, s.adminHeaders, {})).status, 202);
    run = await s.wait(run.id, ['completed']);
    assert.equal((await targetRows(s)).length, 8, 'no duplicates after retry');
    assert.deepEqual(run.records.map((r) => r.attempts).sort(), [1, 1, 1, 1, 1, 1, 1, 2]);
    assert.equal(run.escalation, undefined);
    assert.equal((await s.api(`/api/runs/${run.id}/retry`, s.adminHeaders, {})).status, 409);
    assert.equal((await s.api(`/api/runs/${run.id}/rollback`, s.adminHeaders, {})).status, 202);
    run = await s.wait(run.id, ['rolled_back']);
    assert.equal((await targetRows(s)).length, 0);
    assert.ok(run.events.some((e) => e.title === 'Target change rolled back'));
  } finally {
    await s.close();
  }
});

test('custom endpoint: typed JSON, stable idempotency key, credential from the vault, breaker on a broken target', async () => {
  const api = await receiver((n) => (n <= 3 ? 500 : 201));
  const s = await startWorkspace();
  try {
    const configuration = {
      ...defaultConfiguration(),
      destination: { kind: 'http', url: api.url },
    };
    const created = await s.upload({
      files: await meridian(),
      configuration,
      authorization: 'Bearer target-secret-1',
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    await s.wait(created.body.id, ['partial']);
    let run = await s.waitFor(created.body.id, (r) => !!r.escalation);
    assert.equal(
      api.calls.length,
      3,
      'stopped after three consecutive failures instead of hammering the target',
    );
    assert.equal(
      run.records.filter((r) => r.state === 'ready').length,
      5,
      'the rest were never sent',
    );
    assert.ok(run.events.some((e) => e.title === 'Delivery paused'));
    assert.match(run.escalation!.items.join(' '), /500.*target says no/);
    assert.equal(api.calls[0].auth, 'Bearer target-secret-1');
    assert.equal(
      api.calls[0].service,
      undefined,
      'the internal service credential never leaves for external targets',
    );
    assert.ok(
      !JSON.stringify(run).includes('target-secret-1') &&
        !JSON.stringify(s.store.db.prepare('SELECT * FROM settings').all()).includes(
          'target-secret-1',
        ),
    );

    await s.api(`/api/runs/${run.id}/retry`, s.adminHeaders, {});
    run = await s.wait(run.id, ['completed']);
    assert.equal(api.calls.length, 3 + 8);
    assert.equal(api.calls[0].key, api.calls[3].key, 'a retried record reuses its idempotency key');
    assert.equal(typeof api.calls[3].body.employee_id, 'string');
    assert.equal(
      (await s.api(`/api/runs/${run.id}/rollback`, s.adminHeaders, {})).status,
      409,
      'no undo contract for arbitrary targets',
    );
    assert.equal((await s.api(`/api/runs/${run.id}/payload`)).body.length, 8);
  } finally {
    await s.close();
    await api.close();
  }
});

test('custom schema + endpoint: every record is validated before any request, and types are honoured', async () => {
  const api = await receiver();
  const s = await startWorkspace();
  try {
    const configuration = {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['staffCode', 'contact', 'salary', 'enabled', 'joined'],
        properties: {
          staffCode: { type: 'string', 'x-aliases': ['staff number'] },
          contact: { type: 'string', format: 'email', 'x-aliases': ['business email'] },
          salary: { type: 'integer', minimum: 0 },
          enabled: { type: 'boolean' },
          joined: { type: 'string', format: 'date' },
        },
      },
      identityField: 'staffCode',
      destination: { kind: 'http', url: api.url },
    };
    const created = await s.upload({
      name: 'Contract',
      configuration,
      files: {
        'hr.csv':
          'staff number,business email,salary,enabled,joined\nS1,USER@EXAMPLE.COM,45000,true,04/05/2024',
        'dir.csv':
          'staffCode,contact,salary,enabled,joined\nS1,user@example.com,45000,true,04/05/2024',
      },
    });
    const run = await s.wait(created.body.id, ['review']);
    assert.equal(api.calls.length, 0);
    assert.equal((await s.api(`/api/runs/${run.id}/payload`)).status, 409);
    await answerReviews(s, run.id, { joined: '2024-05-04' });
    await s.wait(run.id, ['completed']);
    assert.deepEqual(api.calls[0].body, {
      staffCode: 'S1',
      contact: 'user@example.com',
      salary: 45000,
      enabled: true,
      joined: '2024-05-04',
    });
    const broken = structuredClone(configuration);
    (broken.schema.properties.salary as { type: string }).type = 'array';
    assert.equal(
      (await s.upload({ files: { 'a.csv': 'x\n1' }, configuration: broken })).status,
      400,
    );
  } finally {
    await s.close();
    await api.close();
  }
});

test('previewing files shows columns and samples without creating anything', async () => {
  const s = await startWorkspace();
  try {
    const ok = await s.upload({ path: '/api/sources/preview', files: await helix() });
    const sources = (
      ok.body as unknown as {
        sources: { name: string; rows: number; columns: { name: string; sample: string[] }[] }[];
      }
    ).sources;
    assert.deepEqual(
      sources.map((x) => [x.name, x.rows]),
      [
        ['hr-core.xlsx · Employees', 8],
        ['legacy-crm.xlsx · Contacts', 5],
      ],
    );
    assert.ok(
      sources[0].columns.some(
        (c) => c.name === 'E-mail (work)' && c.sample[0] === 'priya.nair@example.com',
      ),
    );
    assert.equal(s.store.list().length, 0);
    assert.equal(
      (await s.upload({ path: '/api/sources/preview', files: { 'x.pdf': 'nope' } })).status,
      400,
    );
  } finally {
    await s.close();
  }
});

test('later writes are preserved; rolling back the newer run restores the older state and unblocks the older rollback', async () => {
  const s = await startWorkspace();
  try {
    const first = (await s.upload({ name: 'First', files: await meridian() })).body.id;
    await s.wait(first, ['completed']);
    const second = (await s.upload({ name: 'Second', files: await meridian() })).body.id;
    await s.wait(second, ['completed']);
    await s.api(`/api/runs/${first}/rollback`, s.adminHeaders, {});
    const blocked = await s.wait(first, ['rollback_conflict']);
    assert.ok(blocked.records.every((r) => r.state === 'rollback_conflict'));
    assert.equal((await targetRows(s)).length, 8);
    await s.api(`/api/runs/${second}/rollback`, s.adminHeaders, {});
    await s.wait(second, ['rolled_back']);
    assert.ok((await targetRows(s)).every((r) => r._run === first));
    await s.api(`/api/runs/${first}/rollback`, s.adminHeaders, {});
    await s.wait(first, ['rolled_back']);
    assert.equal((await targetRows(s)).length, 0);
  } finally {
    await s.close();
  }
});

test('untrusted requests: cross-origin mutation, forged target writes and unknown runs are refused', async () => {
  const s = await startWorkspace();
  try {
    assert.equal((await s.api('/api/runs/not-a-run')).status, 404);
    const cross = await fetch(s.base + '/api/settings/ai', {
      method: 'PUT',
      headers: {
        ...s.adminHeaders,
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(cross.status, 403);
    const forged = (headers: Record<string, string>) =>
      fetch(s.base + '/api/mock/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fake:fake', ...headers },
        body: JSON.stringify({ employee_id: 'EMP-1' }),
      });
    assert.equal((await forged({})).status, 403, 'anonymous callers cannot write to the target');
    assert.equal(
      (await forged(s.adminHeaders)).status,
      403,
      'a signed-in user is not the migration service',
    );
    assert.equal(
      (await forged({ 'x-relay-service': s.serviceToken })).status,
      409,
      'even the service cannot write outside an authorized delivery',
    );
    assert.equal(
      (
        await s.upload({
          files: { 'a.csv': 'Staff ID,Full Name,Work Email\nE1,Jo Do,jo@example.com' },
          assignedTo: 'nobody',
        })
      ).status,
      400,
    );
  } finally {
    await s.close();
  }
});

test('lost write responses reuse the original receipt; rollback includes uncertain failed writes', async () => {
  const s = await startWorkspace();
  try {
    const id = (
      await s.upload({
        files: { 'staff.csv': 'Staff ID,Full Name,Email\nEMP-99,Jane Doe,jane@example.com' },
      })
    ).body.id;
    let run = await s.wait(id, ['completed']);
    const row = run.records[0];
    const before = (await targetRows(s))[0] as unknown as { _version: string };
    // Simulate a crash after the target committed but before the outcome was saved locally.
    run.status = 'delivering';
    row.state = 'ready';
    s.store.save(run);
    const again = await fetch(s.base + '/api/mock/records', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-service': s.serviceToken,
        'Idempotency-Key': `${run.id}:${row.id}`,
      },
      body: JSON.stringify({
        employee_id: 'EMP-99',
        full_name: 'Jane Doe',
        email: 'jane@example.com',
      }),
    });
    const body = (await again.json()) as { idempotent: boolean; version: string };
    assert.equal(again.status, 200);
    assert.equal(body.idempotent, true);
    assert.equal(body.version, before._version);
    assert.equal((await targetRows(s)).length, 1);
    run.status = 'partial';
    row.state = 'failed';
    row.error = 'Response lost after commit';
    s.store.save(run);
    await s.api(`/api/runs/${run.id}/rollback`, s.adminHeaders, {});
    run = await s.wait(run.id, ['rolled_back']);
    assert.equal((await targetRows(s)).length, 0);
    assert.equal(run.records[0].state, 'rolled_back');
  } finally {
    await s.close();
  }
});

test('SQLite snapshots and audit survive restart; in-flight work is recovered visibly; older runs are upgraded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-test-'));
  const path = join(dir, 'test.sqlite');
  try {
    const store = new Store(path);
    const now = new Date().toISOString();
    const legacy = {
      id: 'persisted',
      name: 'Persistence',
      createdAt: now,
      updatedAt: now,
      status: 'delivering',
      sources: [],
      mappings: [
        {
          id: 'm',
          sourceId: 's',
          column: 'c',
          target: 'email',
          method: 'model',
          reason: '',
          candidates: [{ field: 'email', score: 0.9 }],
        },
      ],
      records: [],
      cases: [],
      decisions: { case1: { action: 'exclude', at: now } },
      excludedSources: [],
      events: [{ id: 'event1', at: now, kind: 'human', title: 'Decision', detail: 'Saved' }],
      modelMode: 'Rules',
      demo: false,
    } as unknown as Run;
    store.save(legacy);
    store.close();
    const reopened = new Store(path);
    const { recover } = createApp(reopened, () => '');
    recover();
    const loaded = reopened.get('persisted')!;
    assert.equal(loaded.status, 'error');
    assert.equal(loaded.decisions.case1.action, 'exclude');
    assert.equal(
      loaded.configuration.destination.kind,
      'reference',
      'pre-schema runs get the employee contract',
    );
    assert.deepEqual(
      [loaded.mappings[0].method, loaded.mappings[0].candidates[0].confidence],
      ['ai', 0.9],
    );
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM audit').get()!.n, 2);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
