import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, resolveCase } from '../server/engine.js';
import { scenario } from './helpers.js';

test('manual Meridian: ten rows consolidate to eight employees without any review', async () => {
  const run = await scenario('samples/01-meridian');
  assert.equal(
    run.sources.reduce((n, s) => n + s.rows.length, 0),
    10,
  );
  assert.equal(run.records.length, 8);
  assert.equal(run.cases.length, 0);
  assert.equal(run.records.find((r) => r.data.employee_id === 'MR-001')!.lineage.length, 2);
});
test('manual Northstar fixture: exactly date, department and missing-email cases', async () => {
  const run = await scenario('samples/02-northstar');
  assert.equal(run.records.length, 6);
  assert.equal(run.cases.length, 3);
  while (run.cases.length) {
    const c = run.cases[0];
    resolveCase(run, c.id, {
      action: 'correct',
      value:
        c.field === 'start_date'
          ? '2024-05-04'
          : c.field === 'department'
            ? 'People'
            : 'lucas.reed@example.com',
      at: '',
      reason: 'Confirmed client fixture facts.',
    });
  }
  assert.ok(run.records.every((r) => r.state === 'ready'));
});
test('manual Cedar fixture: correction and rejection retain audit while blocking identity guesses', async () => {
  const run = await scenario('samples/03-cedar');
  assert.equal(run.records.length, 5);
  assert.equal(run.cases.length, 3);
  while (run.cases.length) {
    const c = run.cases[0];
    const row = run.records.find((r) => r.id === c.recordId)!;
    resolveCase(run, c.id, {
      action: row.data.employee_id === 'CD-004' ? 'reject' : 'correct',
      value: c.field === 'start_date' ? '2024-02-29' : 'sameer.joshi@example.com',
      at: '',
      reason: 'Confirmed client fixture facts.',
      actor: { id: 'ic', name: 'Consultant', email: 'ic@example.com', role: 'ic' },
    });
  }
  assert.equal(run.records.filter((r) => r.state === 'ready').length, 4);
  assert.equal(run.records.filter((r) => r.state === 'excluded').length, 1);
  assert.ok(
    run.events.some((e) => e.title === 'Record rejected by consultant' && e.actor?.id === 'ic'),
  );
});
