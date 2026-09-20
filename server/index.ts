import { createApp } from './app.js';
import { bootstrapAccounts } from './bootstrap.js';
import { Store } from './store.js';

// Render sets RENDER=true: listen on all interfaces there, localhost everywhere else.
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const store = new Store(process.env.DB_PATH || '.data/relay-operations.sqlite');
const created = await bootstrapAccounts(store);
if (created.length) console.log(`Created account(s) from the environment: ${created.join(', ')}`);
const { app, recover } = createApp(store, () => `http://127.0.0.1:${port}`);
recover();
app.listen(port, host, () => console.log(`Relay workspace: http://${host}:${port}`));
