import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { seedUser } from '../server/auth.js';
import { Store } from '../server/store.js';

/**
 * Creates one administrator and one implementation consultant if they do not exist.
 * Passwords are random and written to a private file next to the database; they are
 * never printed, prefilled in the UI, or stored in plaintext in the database.
 */
const dbPath = process.env.DB_PATH || '.data/relay-operations.sqlite';
const store = new Store(dbPath);
const created = [];
for (const account of [
  { email: 'admin@relay.example', name: 'Alex Morgan', role: 'admin' as const },
  { email: 'ic@relay.example', name: 'Samira Patel', role: 'ic' as const },
]) {
  if (store.db.prepare('SELECT id FROM users WHERE email=?').get(account.email)) continue;
  const password = randomBytes(18).toString('base64url');
  await seedUser(store, account.email, account.name, account.role, password);
  created.push({ ...account, password });
}
if (created.length) {
  await mkdir(dirname(dbPath), { recursive: true });
  const file = join(dirname(dbPath), `credentials-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(created, null, 2), { mode: 0o600 });
  console.log(`Created ${created.length} account(s). Passwords are in ${file} (keep it private).`);
} else console.log('Both accounts already exist; passwords were not changed.');
store.close();
