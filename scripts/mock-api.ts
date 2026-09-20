import express from 'express';
const app = express();
app.use(express.json({ limit: '1mb' }));
const receipts = new Map<string, unknown>();
let failNext = false;
app.get('/records', (_req, res) => res.json([...receipts.values()]));
app.post('/fail-next', (_req, res) => {
  failNext = true;
  res.json({ message: 'Next new delivery will return HTTP 503 before writing.' });
});
app.post('/employees', (req, res) => {
  const key = req.get('idempotency-key');
  if (!key || !req.body || Array.isArray(req.body) || typeof req.body !== 'object')
    return res.status(400).json({ error: 'Supply an Idempotency-Key and JSON object.' });
  if (receipts.has(key)) return res.json({ ok: true, duplicate: true });
  if (failNext) {
    failNext = false;
    return res.status(503).json({ error: 'Requested demonstration failure; retry this record.' });
  }
  receipts.set(key, req.body);
  console.log(
    JSON.stringify({ receivedAt: new Date().toISOString(), key, payload: req.body }, null, 2),
  );
  res.status(201).json({ ok: true });
});
app.listen(4001, '127.0.0.1', () =>
  console.log(
    'Mock API: POST http://127.0.0.1:4001/employees | GET /records | POST /fail-next. Starts empty.',
  ),
);
