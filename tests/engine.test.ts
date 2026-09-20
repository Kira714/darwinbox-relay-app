import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseConfiguration, normalizeValue, buildPayload } from '../server/configuration.js';
import { defaultConfiguration } from '../server/presets.js';
import { parseFile } from '../server/ingest.js';
import { resolveCase } from '../server/engine.js';
import { csvRun } from './helpers.js';

const cfg = defaultConfiguration();
const date = (v: string) => normalizeValue(cfg, 'start_date', v);
test('dates: only unique valid interpretations are normalized; invalid calendar values are rejected', () => {
  assert.equal(date('18/06/2024').value, '2024-06-18');
  assert.equal(date('06/18/2024').value, '2024-06-18');
  assert.equal(date('02/02/2024').value, '2024-02-02');
  assert.deepEqual(date('03/04/2024').options, ['2024-04-03', '2024-03-04']);
  assert.equal(date('31/02/2024').value, '31/02/2024');
  assert.equal(date('2024/02/29').value, '2024-02-29');
});
test('unknown mappings are reviewed before interpreting records; competing columns cannot overwrite a target', async () => {
  const run = await csvRun(
    'Staff ID,Employee Name,Work Email,Email,Mystery\nEMP-1,Ada Lovelace,ada@example.com,other@example.com,value',
  );
  assert.equal(run.cases.length, 2);
  assert.equal(run.records.length, 0);
  const competing = run.cases.find((c) => c.value === 'Email')!;
  assert.throws(
    () => resolveCase(run, competing.id, { action: 'correct', value: 'email', at: '' }),
    /already has/,
  );
  resolveCase(run, competing.id, { action: 'ignore', at: '' });
  resolveCase(run, run.cases[0].id, { action: 'ignore', at: '' });
  assert.equal(run.records[0].data.email, 'ada@example.com');
  assert.equal(run.cases.length, 0);
});
test('identity collisions never silently merge different IDs or same names', async () => {
  const run = await csvRun(
    'Staff ID,Full Name,Email\nEMP-1,Same Name,shared@example.com\nEMP-2,Same Name,shared@example.com',
  );
  assert.equal(run.records.length, 2);
  assert.equal(run.cases[0].kind, 'identity');
  assert.throws(
    () =>
      resolveCase(run, run.cases[0].id, { action: 'correct', value: 'shared@example.com', at: '' }),
    /already uses that value|Another record already uses/,
  );
  resolveCase(run, run.cases[0].id, { action: 'correct', value: 'unique@example.com', at: '' });
  assert.equal(run.cases.length, 0);
  assert.equal(run.records[1].data.email, 'unique@example.com');
});
test('missing IDs stay separate; corrected IDs are checked for collision', async () => {
  const run = await csvRun(
    'Staff ID,Full Name,Email\nEMP-1,Ada One,ada@example.com\n,Ada Two,ada2@example.com',
  );
  assert.equal(run.records.length, 2);
  assert.throws(
    () => resolveCase(run, run.cases[0].id, { action: 'correct', value: 'EMP-1', at: '' }),
    /already uses that value|Another record already uses/,
  );
  resolveCase(run, run.cases[0].id, { action: 'correct', value: 'EMP-2', at: '' });
  assert.equal(run.cases.length, 0);
  assert.equal(run.records[1].data.employee_id, 'EMP-2');
});
test('excluding a record clears all its issues while other employees remain blocked', async () => {
  const run = await csvRun(
    'Staff ID,Full Name,Email,Start Date\nEMP-1,Ada One,,03/04/2024\nEMP-2,Ada Two,,2024-01-01',
  );
  assert.equal(run.cases.length, 3);
  resolveCase(run, run.cases[0].id, { action: 'exclude', at: '' });
  assert.equal(run.cases.length, 1);
  assert.equal(run.records[0].state, 'excluded');
  assert.equal(run.cases[0].recordId, run.records[1].id);
});
test('CSV parsing handles quoting, BOM and rejects repeated/blank headers and uneven records', async () => {
  const [source] = await parseFile(
    'data.csv',
    Buffer.from('\ufeffStaff ID,Full Name,Email\r\nEMP-1,"Doe, Jane",jane@example.com'),
  );
  assert.equal(source.rows[0].values['Full Name'], 'Doe, Jane');
  await assert.rejects(parseFile('bad.csv', Buffer.from('Email,email\na,b')), /unique/);
  await assert.rejects(parseFile('bad.csv', Buffer.from('Email,\na,b')), /nonempty/);
  await assert.rejects(
    parseFile('bad.csv', Buffer.from('Email,Name\na,b,c')),
    /Invalid Record Length/,
  );
  await assert.rejects(parseFile('bad.xls', Buffer.from('bad')), /only UTF-8 CSV/);
});
test('XLSX sheets retain numeric IDs, true dates and Unicode; formulas are refused', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('People');
  sheet.addRow(['Staff ID', 'Full Name', 'Work Email', 'Start Date']);
  sheet.addRow([101, 'Zoë Nguyễn', 'zoe@example.com', new Date('2024-04-18T00:00:00Z')]);
  const parsed = await parseFile('workbook.xlsx', Buffer.from(await book.xlsx.writeBuffer()));
  assert.equal(parsed[0].rows[0].values['Staff ID'], '101');
  assert.equal(parsed[0].rows[0].values['Start Date'], '2024-04-18');
  assert.equal(parsed[0].rows[0].values['Full Name'], 'Zoë Nguyễn');
  sheet.getCell('D2').value = { formula: 'TODAY()', result: 45500 };
  await assert.rejects(
    parseFile('formula.xlsx', Buffer.from(await book.xlsx.writeBuffer())),
    /formula or error/,
  );
});
test('CSV provenance retains physical start lines across blanks and multiline quoted cells', async () => {
  const [source] = await parseFile('multiline.csv', Buffer.from('ID,Name\n\n1,"A\nB"\n\n2,C\n'));
  assert.deepEqual(
    source.rows.map((r) => r.line),
    [3, 6],
  );
});
test('excluding a conflicted duplicate keeps its lineage consolidated', async () => {
  const run = await csvRun(
    'Staff ID,Full Name,Email,Department\nEMP-1,Ada One,ada@example.com,Sales\nEMP-1,Ada One,ada@example.com,People',
  );
  resolveCase(run, run.cases[0].id, { action: 'exclude', at: '' });
  assert.equal(run.records.length, 1);
  assert.equal(run.records[0].state, 'excluded');
  assert.equal(run.records[0].lineage.length, 2);
  assert.equal(run.cases.length, 0);
});

test('a custom schema drives aliases, typing, cleanup and payloads without any employee assumptions', async () => {
  const custom = parseConfiguration({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['sku', 'price'],
      properties: {
        sku: { type: 'string', 'x-aliases': ['item code'] },
        price: { type: 'number', minimum: 0, 'x-aliases': ['unit cost'] },
        active: { type: 'boolean' },
        tier: { type: 'string', enum: ['gold', 'silver'], 'x-value-aliases': { premium: 'gold' } },
      },
    },
    identityField: 'sku',
    destination: { kind: 'reference' },
  });
  const run = await csvRun(
    'Item Code,Unit Cost,Active,Tier\nA-1, 12.50 ,Yes,Premium\nA-2,-3,no,silver',
    null,
    custom,
  );
  assert.equal(run.records[0].data.tier, 'gold');
  assert.deepEqual(buildPayload(custom, run.records[0].data), {
    sku: 'A-1',
    price: 12.5,
    active: true,
    tier: 'gold',
  });
  // The negative price breaks the schema's own bound: it is escalated, not sent.
  assert.equal(run.cases.length, 1);
  assert.equal(run.cases[0].field, 'price');
});
test('schemas that cannot be honoured are rejected up front', () => {
  const base = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    identityField: 'id',
    destination: { kind: 'reference' },
  };
  assert.doesNotThrow(() => parseConfiguration(base));
  assert.throws(() => parseConfiguration({ ...base, identityField: 'missing' }), /identity field/i);
  assert.throws(() =>
    parseConfiguration({
      ...base,
      schema: { ...base.schema, properties: { id: { type: 'array' } } },
    }),
  );
  assert.throws(
    () =>
      parseConfiguration({
        ...base,
        destination: { kind: 'http', url: 'http://169.254.169.254/x' },
      }),
    /metadata/,
  );
  assert.throws(
    () =>
      parseConfiguration({
        ...base,
        destination: { kind: 'http', url: 'https://user:pw@example.com/x' },
      }),
    /credentials/,
  );
});
