import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapAccounts } from '../server/bootstrap.js';
import { Store } from '../server/store.js';

const roles = (store: Store) =>
  store.db
    .prepare('SELECT email, role FROM users ORDER BY role')
    .all()
    .map((r) => `${r.email}:${r.role}`);

test('accounts come from the environment on a fresh disk, and only when configured', async () => {
  const store = new Store(':memory:');
  assert.deepEqual(await bootstrapAccounts(store, {}), []);
  const created = await bootstrapAccounts(store, {
    ADMIN_PASSWORD: 'a-long-admin-password',
    IC_PASSWORD: 'a-long-consultant-pw',
    IC_EMAIL: 'Sam@Example.com',
  });
  assert.deepEqual(created, ['admin@relay.example', 'sam@example.com']);
  assert.deepEqual(roles(store), ['admin@relay.example:admin', 'sam@example.com:ic']);
  store.close();
});

test('existing accounts are never overwritten, and short passwords fail loudly', async () => {
  const store = new Store(':memory:');
  await bootstrapAccounts(store, { ADMIN_PASSWORD: 'first-password-123' });
  const before = store.db.prepare('SELECT password_hash FROM users').get()!.password_hash;
  assert.deepEqual(
    await bootstrapAccounts(store, { ADMIN_PASSWORD: 'different-password-456' }),
    [],
  );
  assert.equal(store.db.prepare('SELECT password_hash FROM users').get()!.password_hash, before);
  await assert.rejects(
    bootstrapAccounts(store, { IC_PASSWORD: 'short' }),
    /IC_PASSWORD must be at least 12/,
  );
  store.close();
});
