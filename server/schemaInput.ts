import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { property, schemaSpec, type Property, type TargetSchema } from './schema.js';

/**
 * Turns whatever a person types, pastes or uploads into the strict flat schema the pipeline
 * uses. Accepted, from most to least detailed:
 *   - a JSON Schema (loosely written is fine: missing `type`, `required`, `additionalProperties`…)
 *   - a list of field objects  [{ "name": "salary", "type": "number", "required": true }]
 *   - a map of field → type    { "salary": "number!", "joined": "date" }   (! = required)
 *   - a sample record          { "id": "E1", "email": "a@b.co", "salary": 5000 }
 *   - just names               ["employee_id", "name", "email"]  |  { "employee_id": "", … }  |  employee_id, name, email
 * JSON or YAML. Types that were not given are inferred from names or sample values and reported
 * as warnings, so nothing is guessed silently.
 */
export type SchemaKind =
  'json-schema' | 'field-list' | 'field-types' | 'sample-record' | 'field-names';
export interface NormalizedSchema {
  kind: SchemaKind;
  schema: TargetSchema;
  identityField: string;
  /** Text fields that can identify a record. */
  identityCandidates: string[];
  warnings: string[];
}

const fail = (message: string): never => {
  throw new Error(message);
};
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const NAME_OK = /^[a-zA-Z][a-zA-Z0-9_]{0,119}$/;
const zodMessage = (e: unknown) =>
  e instanceof ZodError
    ? e.issues
        .map(
          (i) => `${i.path.filter((p) => p !== 'properties').join('.') || 'schema'}: ${i.message}`,
        )
        .join('; ')
    : (e as Error).message;

// ---- names → types ------------------------------------------------------------------
const tokens = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

type Typed = Pick<Property, 'type' | 'format'>;
function inferFromName(name: string): Typed {
  const t = tokens(name);
  const first = t[0];
  const last = t[t.length - 1];
  const has = (...words: string[]) => words.some((w) => t.includes(w));
  if (
    ['is', 'has', 'can', 'should', 'allow', 'allows'].includes(first) ||
    ['active', 'enabled', 'verified', 'flag'].includes(last)
  )
    return { type: 'boolean' };
  if (has('email', 'mail')) return { type: 'string', format: 'email' };
  if (has('date', 'dob', 'doj') || (last === 'on' && t.length > 1))
    return { type: 'string', format: 'date' };
  if (has('age', 'count', 'qty', 'quantity', 'stock', 'year', 'years', 'days'))
    return { type: 'integer' };
  if (
    has(
      'salary',
      'price',
      'amount',
      'cost',
      'fee',
      'balance',
      'ctc',
      'revenue',
      'spend',
      'weight',
      'height',
    )
  )
    return { type: 'number' };
  return { type: 'string' };
}

/** A friendly type word ("whole number", "int", "yes/no", "date"…) → schema type. */
function typeWord(word: string): Typed | 'nested' | undefined {
  switch (
    word
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '')
  ) {
    case 'string':
    case 'text':
    case 'varchar':
    case 'str':
      return { type: 'string' };
    case 'number':
    case 'decimal':
    case 'float':
    case 'double':
    case 'numeric':
      return { type: 'number' };
    case 'integer':
    case 'int':
    case 'long':
    case 'bigint':
    case 'whole':
    case 'wholenumber':
      return { type: 'integer' };
    case 'boolean':
    case 'bool':
    case 'yesno':
    case 'yes/no':
      return { type: 'boolean' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'email':
      return { type: 'string', format: 'email' };
    case 'object':
    case 'array':
      return 'nested';
    default:
      return undefined;
  }
}
const TYPE_WORD =
  /^(string|text|varchar|str|number|decimal|float|double|numeric|integer|int|long|bigint|whole(?:[ _-]?number)?|boolean|bool|yes\/no|date|email)\s*[?!]?$/i;

// ---- field names -------------------------------------------------------------------
interface Draft {
  name: string;
  prop: Property;
  required?: boolean;
}
function cleanName(raw: unknown, renames: string[]): { name: string; title?: string } {
  if (typeof raw !== 'string' || !raw.trim()) return fail('Field names must be non-empty text.');
  const trimmed = raw.trim();
  if (NAME_OK.test(trimmed)) return { name: trimmed };
  let name = trimmed.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) fail(`“${trimmed}” cannot be used as a field name.`);
  if (/^\d/.test(name)) name = `f_${name}`;
  name = name.slice(0, 120);
  renames.push(`“${trimmed}” → ${name}`);
  return { name, title: trimmed.slice(0, 200) };
}

function nameDrafts(list: unknown[], warnings: string[]): Draft[] {
  const renames: string[] = [];
  const drafts = list.map((raw) => {
    const { name, title } = cleanName(raw, renames);
    return { name, prop: { ...inferFromName(name), ...(title ? { title } : {}) } as Property };
  });
  if (renames.length)
    warnings.push(
      `Field names can only contain letters, digits and underscores, so: ${renames.join(', ')}.`,
    );
  const inferred = drafts.filter((d) => d.prop.type !== 'string' || d.prop.format);
  warnings.push(
    `Only names were given, so types were inferred from them${
      inferred.length
        ? ` (${inferred.map((d) => `${d.name} → ${d.prop.format ?? d.prop.type}`).join(', ')})`
        : ' (all text)'
    }. Everything is optional except the identity field. Add types or “required” to be exact.`,
  );
  return drafts;
}

// ---- one property ------------------------------------------------------------------
const IGNORED_SILENTLY = new Set([
  'default',
  'examples',
  'example',
  '$comment',
  'readOnly',
  'writeOnly',
  'deprecated',
  'nullable',
  '$id',
  'id',
  'name',
  'field',
  'key',
  'column',
  'required',
]);
const IGNORED_WITH_WARNING = new Set([
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'const',
  'contentEncoding',
  'contentMediaType',
  'minItems',
  'maxItems',
  'uniqueItems',
]);
const UNSUPPORTED = [
  '$ref',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'items',
  'properties',
];

function propertyDraft(name: string, raw: unknown, warnings: string[]): Draft {
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^(.*?)\s*([?!])?$/)!;
    const t = typeWord(m[1]);
    if (t === 'nested')
      return fail(
        `“${name}” is a nested object/list. Only flat fields are supported; flatten it (for example ${name}_city).`,
      );
    if (!t)
      return fail(
        `“${name}”: “${raw}” is not a known type. Use text, number, whole number, yes/no, date or email.`,
      );
    return { name, prop: t as Property, required: m[2] === '!' };
  }
  if (!isObj(raw)) return fail(`“${name}” must be a type name or an object.`);
  for (const k of UNSUPPORTED)
    if (k in raw)
      return fail(
        k === 'properties' || k === 'items'
          ? `“${name}” is a nested object/list. Only flat fields are supported; flatten it (for example ${name}_city).`
          : `“${name}” uses “${k}”, which is not supported. Describe it as one plain type instead.`,
      );
  let type = raw.type;
  if (Array.isArray(type)) {
    const rest = type.filter((t) => t !== 'null');
    if (rest.length > 1)
      return fail(`“${name}” allows several types (${rest.join(', ')}). Pick one.`);
    type = rest[0];
  }
  let base: Typed;
  if (typeof type === 'string') {
    const t = typeWord(type);
    if (t === 'nested')
      return fail(
        `“${name}” is a nested ${type}. Only flat fields are supported; flatten it (for example ${name}_city).`,
      );
    if (!t) {
      if (/^(date-?time|timestamp)$/i.test(type)) {
        warnings.push(
          `“${name}” is a ${type}; only calendar dates are validated, so it is treated as text.`,
        );
        base = { type: 'string' };
      } else
        return fail(
          `“${name}” has unsupported type “${type}”. Use string, number, integer, boolean, date or email.`,
        );
    } else base = t;
  } else if (Array.isArray(raw.enum) && raw.enum.length) {
    const kinds = new Set(raw.enum.map((v) => typeof v));
    base = {
      type:
        kinds.size === 1 && kinds.has('number')
          ? raw.enum.every(Number.isInteger)
            ? 'integer'
            : 'number'
          : kinds.size === 1 && kinds.has('boolean')
            ? 'boolean'
            : 'string',
    };
  } else {
    base = inferFromName(name);
    warnings.push(
      `“${name}” has no type, so “${base.format ?? base.type}” was inferred from its name.`,
    );
  }
  const out: Record<string, unknown> = { ...base };
  const format = typeof raw.format === 'string' ? raw.format : undefined;
  if (format === 'email' || format === 'date') out.format = format;
  else if (format)
    warnings.push(`“${name}”: format “${format}” is not enforced (supported: email, date).`);
  for (const k of [
    'title',
    'description',
    'enum',
    'pattern',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'x-aliases',
    'x-value-aliases',
    'x-unique',
  ])
    if (k in raw) out[k] = raw[k];
  if (Array.isArray(raw.aliases)) out['x-aliases'] = raw.aliases;
  if (raw.unique === true) out['x-unique'] = true;
  const known = new Set([
    'type',
    'format',
    'title',
    'description',
    'enum',
    'pattern',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'x-aliases',
    'x-value-aliases',
    'x-unique',
    'aliases',
    'unique',
  ]);
  const ignored = Object.keys(raw).filter((k) => !known.has(k) && !IGNORED_SILENTLY.has(k));
  const dropped = ignored.filter((k) => IGNORED_WITH_WARNING.has(k) || !k.startsWith('x-'));
  if (dropped.length)
    warnings.push(`“${name}”: ignored unsupported keyword(s) ${dropped.join(', ')}.`);
  let prop: Property;
  try {
    prop = property.parse(out);
  } catch (e) {
    return fail(`“${name}”: ${zodMessage(e)}`);
  }
  return { name, prop, required: raw.required === true };
}

// ---- assembling -------------------------------------------------------------------
const rank = (name: string) => {
  const last = tokens(name).at(-1) ?? '';
  return last === 'id' || last === 'uuid'
    ? 0
    : ['code', 'sku', 'key', 'ref', 'no', 'num', 'number'].includes(last)
      ? 1
      : 2;
};
export interface NormalizeOptions {
  /** Editing aid: accept a list of fields that has no identity yet (identityField comes back empty). */
  fieldsOnly?: boolean;
}
function assemble(
  kind: SchemaKind,
  drafts: Draft[],
  meta: Partial<Pick<TargetSchema, '$schema' | '$id' | 'title' | 'description'>>,
  warnings: string[],
  identityHint: string | undefined,
  opts: NormalizeOptions,
): NormalizedSchema {
  if (!drafts.length) fail('No fields were found. Give at least one field name.');
  if (drafts.length > 60) fail('Use at most 60 fields.');
  const names = drafts.map((d) => d.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) fail(`The field “${dup}” appears twice.`);
  // Text (or email) fields can identify a record; a date never can.
  const candidates = drafts
    .filter((d) => d.prop.type === 'string' && d.prop.format !== 'date')
    .map((d) => d.name);
  if (!candidates.length && !opts.fieldsOnly)
    fail('Add at least one text field (an ID or code) that identifies each record.');
  let identity: string;
  if (!candidates.length) identity = '';
  else if (identityHint) {
    if (!candidates.includes(identityHint))
      fail(
        `The identity field “${identityHint}” must be one of the text fields: ${candidates.join(', ')}.`,
      );
    identity = identityHint;
  } else {
    identity = [...candidates].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(!!drafts.find((d) => d.name === b)?.required) -
          Number(!!drafts.find((d) => d.name === a)?.required) ||
        names.indexOf(a) - names.indexOf(b),
    )[0];
  }
  const schema = {
    ...meta,
    type: 'object' as const,
    additionalProperties: false as const,
    required: names.filter(
      (n) => (identity && n === identity) || drafts.find((d) => d.name === n)!.required,
    ),
    properties: Object.fromEntries(drafts.map((d) => [d.name, d.prop])),
  };
  try {
    schemaSpec.parse(schema);
  } catch (e) {
    fail(zodMessage(e));
  }
  return { kind, schema, identityField: identity, identityCandidates: candidates, warnings };
}

function readText(text: string): unknown {
  const t = text.trim();
  if (!t)
    return fail(
      'Enter the target fields — names are enough — or paste a JSON Schema or a sample record.',
    );
  if (t.length > 60_000) return fail('That is too large (limit 60 KB).');
  try {
    return JSON.parse(t);
  } catch (jsonError) {
    if (/^[{[]/.test(t)) {
      // Broken JSON: YAML "flow" syntax is close enough that it can succeed, otherwise explain.
      try {
        const y = parseYaml(t);
        if (y && typeof y === 'object') return y;
      } catch {
        /* fall through */
      }
      return fail(`That is not valid JSON (${(jsonError as Error).message}).`);
    }
    try {
      const y = parseYaml(t);
      if (y && typeof y === 'object') return y;
    } catch {
      /* not YAML: treat as a list of names */
    }
    return t
      .split(/[\n,;|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

export function normalizeSchemaInput(
  input: unknown,
  identityHint?: string,
  opts: NormalizeOptions = {},
): NormalizedSchema {
  const warnings: string[] = [];
  const value = typeof input === 'string' ? readText(input) : input;
  return fromValue(value, identityHint || undefined, warnings, opts);
}

const WRAPPERS = ['fields', 'columns', 'attributes', 'names', 'keys'];
function fromValue(
  value: unknown,
  hint: string | undefined,
  warnings: string[],
  opts: NormalizeOptions,
): NormalizedSchema {
  if (Array.isArray(value)) {
    if (value.length && value.every((v) => typeof v === 'string'))
      return assemble('field-names', nameDrafts(value, warnings), {}, warnings, hint, opts);
    if (value.length && value.every(isObj)) {
      if (
        value.every((o) => ['name', 'field', 'key', 'column'].some((k) => typeof o[k] === 'string'))
      ) {
        const renames: string[] = [];
        const drafts = value.map((o) => {
          const raw = ['name', 'field', 'key', 'column']
            .map((k) => o[k])
            .find((v) => typeof v === 'string');
          const { name, title } = cleanName(raw, renames);
          const d = propertyDraft(name, title && !o.title ? { ...o, title } : o, warnings);
          return d;
        });
        if (renames.length)
          warnings.push(
            `Field names can only contain letters, digits and underscores, so: ${renames.join(', ')}.`,
          );
        return assemble('field-list', drafts, {}, warnings, hint, opts);
      }
      warnings.push('A list of records was given; the first one was used as the sample.');
      return fromValue(value[0], hint, warnings, opts);
    }
    return fail('Expected a list of field names, a list of field objects, or an object.');
  }
  if (!isObj(value)) return fail('Expected an object or a list of field names.');

  if (isObj(value.properties) || ('$schema' in value && 'type' in value)) {
    if (!isObj(value.properties)) fail('The schema has no "properties".');
    const props = value.properties as Record<string, unknown>;
    const drafts = Object.entries(props).map(([k, v]) => {
      const renames: string[] = [];
      const { name, title } = cleanName(k, renames);
      if (renames.length)
        warnings.push(
          `Field names can only contain letters, digits and underscores, so: ${renames.join(', ')}.`,
        );
      return propertyDraft(name, title && isObj(v) && !v.title ? { ...v, title } : v, warnings);
    });
    const required = Array.isArray(value.required)
      ? value.required.filter((r): r is string => typeof r === 'string')
      : [];
    for (const r of required)
      if (!drafts.some((d) => d.name === r))
        fail(`“required” lists “${r}”, which is not one of the properties.`);
    for (const d of drafts) if (required.includes(d.name)) d.required = true;
    if (value.additionalProperties === true || isObj(value.additionalProperties))
      warnings.push(
        'Records will contain only the listed fields, even though the schema allows extra properties.',
      );
    const meta: Partial<Pick<TargetSchema, '$schema' | '$id' | 'title' | 'description'>> = {};
    for (const k of ['$schema', '$id', 'title', 'description'] as const)
      if (typeof value[k] === 'string') meta[k] = value[k] as string;
    return assemble('json-schema', drafts, meta, warnings, hint, opts);
  }

  const wrapper = WRAPPERS.find(
    (k) => (Array.isArray(value[k]) || isObj(value[k])) && Object.keys(value).length <= 4,
  );
  if (wrapper) {
    const id = ['identityField', 'identity', 'idField', 'primaryKey']
      .map((k) => value[k])
      .find((v) => typeof v === 'string') as string | undefined;
    return fromValue(value[wrapper], hint ?? id, warnings, opts);
  }

  const entries = Object.entries(value);
  if (!entries.length) return fail('That object is empty. Give at least one field name.');
  const blank = (v: unknown) => v === null || v === '' || v === undefined;
  const typeWordish = (v: unknown) => typeof v === 'string' && TYPE_WORD.test(v.trim());
  if (entries.every(([, v]) => blank(v) || typeWordish(v))) {
    if (entries.every(([, v]) => blank(v)))
      return assemble(
        'field-names',
        nameDrafts(
          entries.map(([k]) => k),
          warnings,
        ),
        {},
        warnings,
        hint,
        opts,
      );
    const renames: string[] = [];
    const drafts = entries.map(([k, v]) => {
      const { name, title } = cleanName(k, renames);
      const d = blank(v)
        ? { name, prop: inferFromName(name) as Property }
        : propertyDraft(name, v, warnings);
      if (title) d.prop = { ...d.prop, title };
      return d;
    });
    if (renames.length)
      warnings.push(
        `Field names can only contain letters, digits and underscores, so: ${renames.join(', ')}.`,
      );
    const untyped = entries.filter(([, v]) => blank(v)).map(([k]) => k);
    if (untyped.length)
      warnings.push(
        `No type was given for ${untyped.join(', ')}, so it was inferred from the name.`,
      );
    return assemble('field-types', drafts, {}, warnings, hint, opts);
  }
  if (entries.every(([, v]) => isObj(v))) {
    const renames: string[] = [];
    const drafts = entries.map(([k, v]) => {
      const { name, title } = cleanName(k, renames);
      return propertyDraft(
        name,
        title && !(v as Record<string, unknown>).title ? { ...(v as object), title } : v,
        warnings,
      );
    });
    if (renames.length)
      warnings.push(
        `Field names can only contain letters, digits and underscores, so: ${renames.join(', ')}.`,
      );
    return assemble('field-list', drafts, {}, warnings, hint, opts);
  }
  // A sample record: infer from the values.
  const renames: string[] = [];
  const drafts = entries.map(([k, v]): Draft => {
    const { name, title } = cleanName(k, renames);
    if (isObj(v) || Array.isArray(v))
      return fail(
        `“${k}” holds a nested ${Array.isArray(v) ? 'list' : 'object'}. Only flat fields are supported; flatten it (for example ${name}_city).`,
      );
    let prop: Typed;
    if (blank(v)) prop = inferFromName(name);
    else if (typeof v === 'boolean') prop = { type: 'boolean' };
    else if (typeof v === 'number')
      prop =
        rank(name) < 2
          ? { type: 'string' }
          : Number.isInteger(v)
            ? { type: 'integer' }
            : { type: 'number' };
    else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v)))
      prop = { type: 'string', format: 'email' };
    else if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) prop = { type: 'string', format: 'date' };
    else if (/^(true|false)$/i.test(String(v))) prop = { type: 'boolean' };
    else prop = { type: 'string' };
    return { name, prop: { ...prop, ...(title ? { title } : {}) } as Property };
  });
  if (renames.length)
    warnings.push(
      `Field names can only contain letters, digits and underscores, so: ${renames.join(', ')}.`,
    );
  warnings.push(
    'Types were inferred from the sample values. Everything is optional except the identity field.',
  );
  return assemble('sample-record', drafts, {}, warnings, hint, opts);
}
