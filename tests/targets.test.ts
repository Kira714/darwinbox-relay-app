import test from 'node:test';
import assert from 'node:assert/strict';
import { cataloguePreset, crmPreset, payrollPreset } from '../server/presets.js';
import { normalizeSchemaInput } from '../server/schemaInput.js';
import { parseConfiguration } from '../server/configuration.js';
import { readFile } from 'node:fs/promises';
import { parseFile } from '../server/ingest.js';
import { mapSources } from '../server/mapping.js';
import { reconcile } from '../server/engine.js';
import { makeRun, startWorkspace, stubAi } from './helpers.js';
import type { Preset } from '../server/presets.js';

async function runPreset(
  preset: Preset,
  ai: ReturnType<typeof stubAi> | null,
  schema: unknown = preset.schema,
  identity = preset.identityField,
) {
  const sources = (
    await Promise.all(
      preset.sample.files.map(async (f) =>
        parseFile(f, await readFile(`samples/${preset.sample.folder}/${f}`)),
      ),
    )
  ).flat();
  const { configuration } = {
    configuration: parseConfiguration({
      schema,
      identityField: identity,
      destination: { kind: 'reference' },
    }),
  };
  const run = makeRun(sources, configuration);
  await mapSources(run, ai);
  reconcile(run);
  return run;
}
const kinds = (run: Awaited<ReturnType<typeof runPreset>>) =>
  run.cases.map((c) => `${c.kind}:${c.field}`).sort();

test('payroll target: alias + AI mapping, and one dirty cell does not turn a correct mapping into a mapping question', async () => {
  const ai = stubAi({
    'Staff No': { target: 'staffCode' },
    'Full Legal Name': { target: 'fullName' },
    'Corporate Mail': { target: 'workEmail' },
    'Pay Grade': { target: 'grade' },
    'Annual CTC': { target: 'salary' },
    'Cost Centre': { target: null },
  });
  const run = await runPreset(payrollPreset, ai);
  assert.equal(run.records.length, 8, '10 rows, 2 people in both files');
  assert.deepEqual(kinds(run), [
    'conflict:salary',
    'date:joinedOn',
    'validation:grade',
    'validation:salary',
  ]);
  assert.equal(
    run.mappings.filter((m) => m.method === 'ai').length,
    4,
    'Pay Grade matches the field title, so only 4 columns need the AI',
  );
  assert.equal(
    run.records.find((r) => r.data.staffCode === 'PY0101')!.data.fullTime,
    'true',
    'Yes → true',
  );
  assert.equal(
    run.records.find((r) => r.data.staffCode === 'PY0101')!.data.workEmail,
    'anita.desai@example.com',
  );
});

test('CRM target: country names become ISO codes on their own; the three real problems are escalated', async () => {
  const ai = stubAi({
    Subscribed: { target: null },
    'Total Spend (USD)': { target: 'lifetime_value' },
  });
  const run = await runPreset(crmPreset, ai);
  assert.equal(run.records.length, 7);
  assert.deepEqual(kinds(run), [
    'date:signed_up',
    'validation:country',
    'validation:lifetime_value',
  ]);
  assert.equal(
    run.records.find((r) => r.data.contact_id === 'C-1004')!.data.country,
    'US',
    'USA and United States agree',
  );
  assert.equal(run.records.find((r) => r.data.contact_id === 'C-1002')!.data.country, 'GB');
});

test('catalogue target: five planted problems; 89.90 vs 89.9 is not a conflict', async () => {
  const run = await runPreset(cataloguePreset, stubAi({ 'Price (USD)': { target: 'price' } }));
  assert.equal(run.records.length, 8);
  assert.deepEqual(kinds(run), [
    'conflict:stock',
    'date:launched',
    'validation:price',
    'validation:sku',
    'validation:stock',
  ]);
  assert.equal(run.records.find((r) => r.data.sku === 'TS-100')!.data.price, '89.9');
  assert.equal(
    run.records.find((r) => r.data.sku === 'TS-103')!.data.category,
    'home',
    'Homeware → home',
  );
});

test('every example file in samples/schemas is understood and pairs with its sample data', async () => {
  const load = async (f: string) => readFile(`samples/schemas/${f}`, 'utf8');
  const cases: [string, string, Preset, string][] = [
    ['payroll.schema.json', 'json-schema', payrollPreset, 'staffCode'],
    ['crm.sample-record.json', 'sample-record', crmPreset, 'contact_id'],
    ['catalogue.fields.json', 'field-types', cataloguePreset, 'sku'],
  ];
  for (const [file, kind, preset, identity] of cases) {
    const n = normalizeSchemaInput(await load(file));
    assert.equal(n.kind, kind, file);
    assert.equal(n.identityField, identity, file);
    // The example schemas describe the same fields as the presets, so their sample data maps.
    assert.deepEqual(
      Object.keys(n.schema.properties).sort(),
      Object.keys(preset.schema.properties).sort(),
      file,
    );
  }
  for (const file of ['employee.names.json', 'employee.fields.yaml']) {
    const n = normalizeSchemaInput(await load(file));
    assert.equal(n.identityField, 'employee_id', file);
    assert.equal(Object.keys(n.schema.properties).length, 7, file);
  }
});

test('names-only target end to end: paste field names, upload the Excel files, AI maps, the agent escalates the real problems', async () => {
  // The user's scenario: they type only names. Types come from the names; only the identity is required.
  const ai = stubAi({
    'Emp Code': { target: 'employee_id' },
    'Personnel No.': { target: 'employee_id' },
    'Nombre completo': { target: 'full_name' },
    Name: { target: 'full_name' },
    'E-mail (work)': { target: 'email' },
    Mail: { target: 'email' },
    'Org Unit': { target: 'department' },
    Division: { target: 'department' },
    'Position Held': { target: 'job_title' },
    Role: { target: 'job_title' },
    'Onboarding Date': { target: 'start_date' },
    'Joined On': { target: 'start_date' },
    'Emp Status': { target: 'employment_status' },
    'Favourite Colour': { target: null },
    'Manager Name': { target: null },
  });
  const s = await startWorkspace({ ai: () => ai });
  try {
    const files = Object.fromEntries(
      await Promise.all(
        ['hr-core.xlsx', 'legacy-crm.xlsx'].map(async (f) => [
          f,
          await readFile(`samples/04-helix/${f}`),
        ]),
      ),
    );
    const created = await s.upload({
      name: 'Names only',
      files,
      configuration: {
        schema:
          'employee_id, full_name, email, department, job_title, start_date, employment_status',
        destination: { kind: 'reference' },
      },
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const run = await s.wait(created.body.id, ['review']);
    assert.equal(run.configuration.identityField, 'employee_id');
    assert.deepEqual(run.configuration.schema.required, ['employee_id']);
    assert.equal(run.records.length, 10);
    // Only the genuinely ambiguous date and the department conflict remain: with only names, an
    // absent email is allowed (it was never declared required) — the schema decides what "invalid" means.
    assert.deepEqual(run.cases.map((c) => c.kind).sort(), ['conflict', 'date']);
  } finally {
    await s.close();
  }
});

test('the schema editor endpoint reports what it understood, and serves only whitelisted sample files', async () => {
  const s = await startWorkspace();
  try {
    const ok = await s.api('/api/configuration/validate', s.adminHeaders, {
      schema: 'sku, name, price, launched_on',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.kind, 'field-names');
    assert.equal(ok.body.identityField, 'sku');
    assert.deepEqual(
      ok.body.fields.map((f: { name: string; type: string; required: boolean }) => [
        f.name,
        f.type,
        f.required,
      ]),
      [
        ['sku', 'string', true],
        ['name', 'string', false],
        ['price', 'number', false],
        ['launched_on', 'string', false],
      ],
    );
    const bad = await s.api('/api/configuration/validate', s.adminHeaders, {
      schema: { id: '1', address: { city: 'x' } },
    });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.error, /address_city/);
    assert.equal(
      (await s.api('/api/configuration/validate', s.icHeaders, { schema: 'a' })).status,
      403,
    );
    assert.equal((await s.api('/api/presets')).body.length, 4);

    const file = await fetch(`${s.base}/api/samples/payroll/hr-portal.csv`, {
      headers: s.adminHeaders,
    });
    assert.equal(file.status, 200);
    assert.match(await file.text(), /^StaffCode,Name,Email/);
    for (const path of [
      '/api/samples/payroll/..%2F..%2Fpackage.json',
      '/api/samples/payroll/finance-ledger.xlsx.bak',
      '/api/samples/nope/x.csv',
      '/api/samples/employee/hr-portal.csv',
    ])
      assert.equal((await fetch(s.base + path, { headers: s.adminHeaders })).status, 404, path);
    assert.equal(
      (await fetch(`${s.base}/api/samples/payroll/hr-portal.csv`)).status,
      401,
      'sign-in required',
    );
  } finally {
    await s.close();
  }
});
