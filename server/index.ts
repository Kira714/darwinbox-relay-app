import { createApp } from './app.js';
import { Store } from './store.js';

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const store = new Store(process.env.DB_PATH || '.data/relay-operations.sqlite');
const { app, recover } = createApp(store, () => `http://127.0.0.1:${port}`);
recover();
app.listen(port, host, () => console.log(`Relay workspace: http://${host}:${port}`));
