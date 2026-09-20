import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { seedUser } from '../server/auth.js';
import { defaultConfiguration } from '../server/presets.js';
import type { Run } from '../server/types.js';
async function setup() {
  const store = new Store(':memory:');
  const admin = await seedUser(store, 'admin@test.example', 'Admin', 'admin', 'TestPassword!2026');
  const ic = await seedUser(store, 'ic@test.example', 'Consultant', 'ic', 'TestPassword!2026');
  const other = await seedUser(
    store,
    'other@test.example',
    'Other consultant',
    'ic',
    'TestPassword!2026',
  );
  let base = '';
  const { app } = createApp(store, () => base);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = async (email: string) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestPassword!2026' }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { csrfToken: string };
    return { Cookie: r.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': body.csrfToken };
  };
  const adminHeaders = await login(admin.email),
    icHeaders = await login(ic.email),
    otherHeaders = await login(other.email);
  const api = async (path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const r = await fetch(base + path, {
      headers: { 'Content-Type': 'application/json', ...headers },
      method: body ? 'POST' : 'GET',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  };
  const run = () => {
    const now = new Date().toISOString();
    const r: Run = {
      id: 'assigned',
      name: 'Restricted migration',
      createdAt: now,
      updatedAt: now,
      status: 'review',
      configuration: defaultConfiguration(),
      sources: [],
      mappings: [],
      records: [],
      cases: [],
      decisions: {},
      excludedSources: [],
      events: [],
      assignedTo: ic.id,
    };
    store.save(r);
    return r;
  };
  return {
    store,
    admin,
    ic,
    other,
    base,
    login,
    adminHeaders,
    icHeaders,
    otherHeaders,
    api,
    close,
    run,
  };
}
test('authentication and assignment protect reads, downloads, users and operator endpoints', async () => {
  const s = await setup();
  try {
    s.run();
    for (const path of [
      '/api/runs',
      '/api/users',
      '/api/runs/assigned',
      '/api/runs/assigned/audit',
      '/api/runs/assigned/export',
    ])
      assert.equal((await s.api(path)).status, 401);
    assert.equal((await s.api('/api/runs/assigned', s.icHeaders)).status, 200);
    assert.equal((await s.api('/api/runs/assigned', s.otherHeaders)).status, 404);
    assert.equal((await s.api('/api/runs', s.otherHeaders)).body.length, 0);
    for (const path of ['/api/runs/assigned/audit', '/api/runs/assigned/summary'])
      assert.equal((await s.api(path, s.otherHeaders)).status, 404);
    assert.equal((await s.api('/api/users', s.icHeaders)).status, 403);
    assert.equal((await s.api('/api/mock/records', s.icHeaders)).status, 403);
    for (const path of [
      '/api/sources/preview',
      '/api/settings/ai/test',
      '/api/runs',
      '/api/runs/assigned/rollback',
      '/api/runs/assigned/assign',
      '/api/runs/assigned/retry',
    ])
      assert.equal((await s.api(path, s.icHeaders, {})).status, 403);
    assert.equal(
      (await s.api('/api/mock/records', s.adminHeaders, { employee_id: 'x' })).status,
      403,
    );
  } finally {
    await s.close();
  }
});
test('CSRF, session revocation, expiry and password changes are enforced', async () => {
  const s = await setup();
  try {
    assert.equal((await s.api('/api/auth/logout', { Cookie: s.icHeaders.Cookie }, {})).status, 403);
    assert.equal((await s.api('/api/auth/logout', s.icHeaders, {})).status, 200);
    assert.equal((await s.api('/api/auth/me', s.icHeaders)).status, 401);
    assert.equal(
      (
        await s.api('/api/auth/password', s.adminHeaders, {
          currentPassword: 'Wrong',
          newPassword: 'NewPassword!2026',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await s.api('/api/auth/password', s.adminHeaders, {
          currentPassword: 'TestPassword!2026',
          newPassword: 'NewPassword!2026',
        })
      ).status,
      200,
    );
    assert.equal((await s.api('/api/auth/me', s.adminHeaders)).status, 401);
    s.store.db.prepare('UPDATE sessions SET expires_at=0').run();
    assert.equal((await s.api('/api/auth/me', s.otherHeaders)).status, 401);
    const row = s.store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(s.admin.id)!;
    assert.ok(!String(row.password_hash).includes('NewPassword'));
  } finally {
    await s.close();
  }
});
test('reassignment revokes prior access, revision conflicts reject stale changes, and actors are server-owned', async () => {
  const s = await setup();
  try {
    let run = s.run();
    const first = await s.api('/api/runs/assigned/assign', s.adminHeaders, {
      assignedTo: s.other.id,
      expectedRevision: run.revision,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.events[0].actor.id, s.admin.id);
    assert.equal((await s.api('/api/runs/assigned', s.icHeaders)).status, 404);
    assert.equal((await s.api('/api/runs/assigned', s.otherHeaders)).status, 200);
    assert.equal(
      (
        await s.api('/api/runs/assigned/assign', s.adminHeaders, {
          assignedTo: s.ic.id,
          expectedRevision: run.revision,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await s.api('/api/runs/assigned/resolve', s.otherHeaders, {
          caseId: 'fake',
          expectedRevision: run.revision,
          decision: { action: 'correct', value: 'x', reason: 'Confirmed by the client.' },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await s.api('/api/runs/assigned/resolve', s.otherHeaders, {
          caseId: 'fake',
          expectedRevision: first.body.revision,
          decision: {
            action: 'correct',
            reason: 'Confirmed by the client.',
            actor: { id: s.admin.id },
          },
        })
      ).status,
      400,
    );
  } finally {
    await s.close();
  }
});
test('login limits and indistinguishable invalid credentials', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 8; i++)
      assert.equal(
        (await s.api('/api/auth/login', {}, { email: s.ic.email, password: 'wrong' })).status,
        401,
      );
    assert.equal(
      (await s.api('/api/auth/login', {}, { email: s.ic.email, password: 'wrong' })).status,
      429,
    );
    const missing = await s.api(
      '/api/auth/login',
      {},
      { email: 'nobody@test.example', password: 'wrong' },
    );
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error, 'Email or password is incorrect.');
  } finally {
    await s.close();
  }
});
