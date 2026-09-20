import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchemaInput } from '../server/schemaInput.js';
import { parseConfiguration, resolveConfiguration } from '../server/configuration.js';
import { employeePreset } from '../server/presets.js';

const spec = (input: unknown, hint?: string) => normalizeSchemaInput(input, hint);
const types = (n: ReturnType<typeof spec>) =>
  Object.fromEntries(Object.entries(n.schema.properties).map(([k, p]) => [k, p.format ?? p.type]));

test('just names: JSON array, keys-only JSON, comma text and YAML list all work; types are inferred and disclosed', () => {
  const inputs: unknown[] = [
    ['employee_id', 'full_name', 'email', 'joined_on', 'salary', 'is_active'],
    { employee_id: '', full_name: null, email: '', joined_on: '', salary: '', is_active: '' },
    'employee_id, full_name, email, joined_on, salary, is_active',
    'employee_id\nfull_name\nemail\njoined_on\nsalary\nis_active',
    '- employee_id\n- full_name\n- email\n- joined_on\n- salary\n- is_active',
    '{"fields": ["employee_id", "full_name", "email", "joined_on", "salary", "is_active"]}',
  ];
  for (const input of inputs) {
    const n = spec(input);
    assert.equal(n.kind, 'field-names');
    assert.deepEqual(types(n), {
      employee_id: 'string',
      full_name: 'string',
      email: 'email',
      joined_on: 'date',
      salary: 'number',
      is_active: 'boolean',
    });
    assert.equal(n.identityField, 'employee_id');
    assert.deepEqual(
      n.schema.required,
      ['employee_id'],
      'only the identity is required when only names were given',
    );
    assert.match(n.warnings.join(' '), /Only names were given.*email → email.*salary → number/);
    assert.doesNotThrow(() =>
      parseConfiguration({ schema: input, destination: { kind: 'reference' } }),
    );
  }
});

test('names with spaces or symbols are renamed safely and the rename is reported', () => {
  const n = spec(['Employee ID', 'Full Name', 'E-mail', '2nd Manager']);
  assert.deepEqual(Object.keys(n.schema.properties), [
    'Employee_ID',
    'Full_Name',
    'E_mail',
    'f_2nd_Manager',
  ]);
  assert.equal(n.schema.properties.Employee_ID.title, 'Employee ID');
  assert.match(n.warnings.join(' '), /“Employee ID” → Employee_ID/);
  assert.equal(n.identityField, 'Employee_ID');
  assert.throws(() => spec(['a', 'a']), /appears twice/);
  assert.throws(() => spec(['Full Name', 'full_name', 'Full-Name']), /appears twice/);
});

test('field map with types: ! marks required, ? optional, untyped ones are inferred', () => {
  const n = spec({
    employee_id: 'string!',
    salary: 'whole number!',
    joined: 'date',
    email: 'email?',
    notes: '',
  });
  assert.equal(n.kind, 'field-types');
  assert.deepEqual(types(n), {
    employee_id: 'string',
    salary: 'integer',
    joined: 'date',
    email: 'email',
    notes: 'string',
  });
  assert.deepEqual(n.schema.required, ['employee_id', 'salary']);
});

test('field list of objects: name, type and a required flag, with friendly type words', () => {
  const n = spec([
    { name: 'sku', type: 'text', required: true },
    { field: 'price', type: 'decimal', required: true, minimum: 0 },
    { name: 'active', type: 'yes/no' },
    { name: 'launched' },
  ]);
  assert.equal(n.kind, 'field-list');
  assert.deepEqual(types(n), {
    sku: 'string',
    price: 'number',
    active: 'boolean',
    launched: 'string',
  });
  assert.deepEqual(n.schema.required, ['sku', 'price']);
  assert.equal(n.schema.properties.price.minimum, 0);
  assert.match(n.warnings.join(' '), /“launched” has no type/);
});

test('sample record: types come from the values; numeric IDs stay text; nested values are refused with advice', () => {
  const n = spec({
    id: 101,
    name: 'Ada',
    email: 'ada@example.com',
    joined: '2024-05-04',
    salary: 52000.5,
    seats: 3,
    vip: true,
    notes: null,
  });
  assert.equal(n.kind, 'sample-record');
  assert.deepEqual(types(n), {
    id: 'string',
    name: 'string',
    email: 'email',
    joined: 'date',
    salary: 'number',
    seats: 'integer',
    vip: 'boolean',
    notes: 'string',
  });
  assert.equal(n.identityField, 'id');
  assert.throws(
    () => spec({ id: '1', address: { city: 'Pune' } }),
    /“address” holds a nested object.*address_city/,
  );
  assert.throws(() => spec({ id: '1', tags: ['a'] }), /nested list/);
});

test('YAML and loosely written JSON Schema are accepted; unsupported constructs are explained', () => {
  const yaml = spec(
    'type: object\nproperties:\n  code:\n    type: string\n  age:\n    type: integer\n    minimum: 18\nrequired: [code]',
  );
  assert.equal(yaml.kind, 'json-schema');
  assert.equal(yaml.schema.properties.age.minimum, 18);
  assert.equal(yaml.identityField, 'code');

  const loose = spec({
    properties: {
      staff_id: { type: ['string', 'null'] },
      dob: { type: 'string', format: 'date-time' },
      level: { enum: [1, 2, 3] },
      score: { type: 'number', exclusiveMinimum: 0, default: 5 },
    },
    required: ['staff_id'],
  });
  assert.deepEqual(types(loose), {
    staff_id: 'string',
    dob: 'string',
    level: 'integer',
    score: 'number',
  });
  assert.match(loose.warnings.join(' '), /format “date-time” is not enforced/);
  assert.match(loose.warnings.join(' '), /ignored unsupported keyword\(s\) exclusiveMinimum/);
  assert.ok(!loose.warnings.join(' ').includes('default'), 'annotations are ignored silently');
  assert.equal(loose.schema.additionalProperties, false);

  assert.throws(() => spec({ properties: { a: { type: 'object' } } }), /nested object.*flatten/);
  assert.throws(
    () => spec({ properties: { a: { $ref: '#/x' } } }),
    /“\$ref”, which is not supported/,
  );
  assert.throws(
    () => spec({ properties: { a: { type: ['string', 'number'] } } }),
    /allows several types/,
  );
  assert.throws(
    () => spec({ properties: { a: { type: 'string' } }, required: ['zzz'] }),
    /“zzz”, which is not one of the properties/,
  );
  assert.throws(() => spec('{"a": '), /not valid JSON/);
  assert.throws(() => spec(''), /Enter the target fields/);
  assert.throws(() => spec([]), /Expected a list/);
});

test('identity: guessed sensibly, overridable, and must be a text field', () => {
  assert.equal(spec(['name', 'email', 'staff_code', 'id']).identityField, 'id');
  assert.equal(spec(['name', 'email', 'staffCode']).identityField, 'staffCode');
  assert.equal(spec(['name', 'email']).identityField, 'name');
  assert.equal(spec(['name', 'email', 'id'], 'email').identityField, 'email');
  assert.deepEqual(spec(['name', 'email', 'id', 'salary']).identityCandidates, [
    'name',
    'email',
    'id',
  ]);
  assert.throws(
    () => spec(['name', 'id', 'salary'], 'salary'),
    /identity field “salary” must be one of the text fields/,
  );
  assert.throws(() => spec({ age: 'number', height: 'number' }), /at least one text field/);
  assert.ok(
    spec(['name', 'code'], 'name').schema.required.includes('name'),
    'the identity is always required',
  );
});

test('strict schemas pass through unchanged, so presets and saved runs are stable', () => {
  const n = spec(employeePreset.schema, employeePreset.identityField);
  assert.deepEqual(n.schema, employeePreset.schema);
  assert.deepEqual(n.warnings, []);
});

test('a configuration can be given loosely: identity is inferred, and the destination is still checked', () => {
  const { configuration, normalized } = resolveConfiguration({
    schema: 'sku, name, price',
    destination: { kind: 'reference' },
  });
  assert.equal(configuration.identityField, 'sku');
  assert.equal(normalized.kind, 'field-names');
  assert.throws(
    () =>
      parseConfiguration({
        schema: ['id'],
        destination: { kind: 'http', url: 'http://169.254.169.254/x' },
      }),
    /metadata/,
  );
});

test('a date can never be the field that identifies a record; email can', () => {
  assert.deepEqual(spec(['sku', 'launched_on', 'email']).identityCandidates, ['sku', 'email']);
  assert.equal(spec(['launched_on', 'email']).identityField, 'email');
  assert.throws(() => spec(['launched_on', 'price']), /at least one text field/);
  // Editing aid: a list with no ID yet is accepted, and reports no identity.
  const n = normalizeSchemaInput(['price', 'stock'], undefined, { fieldsOnly: true });
  assert.equal(n.identityField, '');
  assert.deepEqual(n.schema.required, []);
});
