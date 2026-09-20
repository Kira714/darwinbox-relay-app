import { seedUser } from './auth.js';
import type { Store } from './store.js';

/**
 * Creates the administrator and consultant from environment variables when they do not exist.
 * For hosts with an ephemeral disk (accounts are lost on every restart): set ADMIN_PASSWORD and
 * IC_PASSWORD and the workspace is usable again after each boot. Existing accounts are never
 * touched, so on a persistent disk this cannot overwrite a changed password.
 */
export async function bootstrapAccounts(store: Store, env: NodeJS.ProcessEnv = process.env) {
  const created: string[] = [];
  for (const account of [
    { key: 'ADMIN', email: 'admin@relay.example', name: 'Alex Morgan', role: 'admin' as const },
    { key: 'IC', email: 'ic@relay.example', name: 'Samira Patel', role: 'ic' as const },
  ]) {
    const password = env[`${account.key}_PASSWORD`];
    if (!password) continue;
    if (password.length < 12)
      throw new Error(`${account.key}_PASSWORD must be at least 12 characters.`);
    const email = (env[`${account.key}_EMAIL`] || account.email).toLowerCase();
    if (store.db.prepare('SELECT id FROM users WHERE email=?').get(email)) continue;
    await seedUser(
      store,
      email,
      env[`${account.key}_NAME`] || account.name,
      account.role,
      password,
    );
    created.push(email);
  }
  return created;
}
