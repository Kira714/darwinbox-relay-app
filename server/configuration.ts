import { z } from 'zod';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Row } from './types.js';

/**
 * A migration's contract: the target JSON Schema (a documented flat subset),
 * the field that identifies a record, and where records are delivered.
 * Everything downstream (mapping, cleanup, validation, delivery) is driven by this.
 */
const property = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean']),
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    format: z.enum(['email', 'date']).optional(),
    enum: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .max(100)
      .optional(),
    pattern: z.string().max(300).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().max(2000).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    /** Confirmed source-column synonyms; matched before any AI is consulted. */
    'x-aliases': z.array(z.string().max(120)).max(50).optional(),
    /** Source value → canonical enum value, applied during safe cleanup. */
    'x-value-aliases': z.record(z.string(), z.string()).optional(),
    /** Values must be unique across records (in addition to the identity field). */
    'x-unique': z.boolean().optional(),
  })
  .strict();
export type Property = z.infer<typeof property>;

const schemaSpec = z
  .object({
    $schema: z.string().optional(),
    $id: z.string().optional(),
    title: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    type: z.literal('object'),
    additionalProperties: z.literal(false),
    required: z.array(z.string()),
    properties: z.record(z.string(), property),
  })
  .strict();
export type TargetSchema = z.infer<typeof schemaSpec>;

const destination = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reference') }).strict(),
  z
    .object({ kind: z.literal('http'), url: z.string().url(), hasAuth: z.boolean().optional() })
    .strict(),
]);
export type Destination = z.infer<typeof destination>;

const configurationSpec = z
  .object({ schema: schemaSpec, identityField: z.string(), destination })
  .strict();
export type Configuration = z.infer<typeof configurationSpec>;

const ajv = new Ajv({ strict: false, validateFormats: true });
addFormats(ajv);
const compiled = new WeakMap<object, ValidateFunction>();
function validator(spec: Property) {
  let fn = compiled.get(spec);
  if (!fn) {
    const { 'x-aliases': _a, 'x-value-aliases': _v, 'x-unique': _u, ...rest } = spec;
    fn = ajv.compile(rest);
    compiled.set(spec, fn);
  }
  return fn;
}

export function parseConfiguration(input: unknown): Configuration {
  const config = configurationSpec.parse(input);
  const fields = Object.keys(config.schema.properties);
  if (
    !fields.length ||
    fields.length > 60 ||
    fields.some((k) => !/^[a-zA-Z][a-zA-Z0-9_]{0,119}$/.test(k))
  )
    throw new Error('Use 1–60 named flat properties (letters, digits and underscores).');
  if (config.schema.required.some((k) => !config.schema.properties[k]))
    throw new Error('Every required field must exist in properties.');
  if (config.schema.properties[config.identityField]?.type !== 'string')
    throw new Error('The identity field must be a string property in the schema.');
  if (!config.schema.required.includes(config.identityField))
    throw new Error('The identity field must be listed as required.');
  for (const [name, spec] of Object.entries(config.schema.properties)) {
    try {
      validator(spec);
    } catch (e) {
      throw new Error(`Field “${name}” has an invalid constraint: ${(e as Error).message}`);
    }
  }
  if (config.destination.kind === 'http') {
    const url = new URL(config.destination.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error('Use an HTTP(S) URL without credentials or a fragment.');
    if (['169.254.169.254', 'metadata.google.internal'].includes(url.hostname))
      throw new Error('Cloud metadata endpoints cannot be migration targets.');
  }
  return config;
}

export const fieldNames = (c: Configuration) => Object.keys(c.schema.properties);
export const isRequired = (c: Configuration, field: string) => c.schema.required.includes(field);
export const specOf = (c: Configuration, field: string) => c.schema.properties[field];
export const identityFields = (c: Configuration) => [
  ...new Set([
    c.identityField,
    ...Object.entries(c.schema.properties)
      .filter(([, p]) => p['x-unique'])
      .map(([k]) => k),
  ]),
];

/** Lowercase, punctuation-insensitive key used for header/alias/enum matching. */
export function key(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function validDate(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  const year = Number(v.slice(0, 4));
  return (
    !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v && year >= 1900 && year <= 2100
  );
}
function iso(y: number, m: number, d: number) {
  const v = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return validDate(v) ? v : '';
}

export function typedValue(value: string, spec: Property): string | number | boolean {
  if (spec.type === 'boolean') return value === 'true' ? true : value === 'false' ? false : value;
  if (
    (spec.type === 'number' || spec.type === 'integer') &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) &&
    Number.isFinite(Number(value))
  )
    return Number(value);
  return value;
}

/** Returns a human-readable problem, or null when the value satisfies the field's contract. */
export function validateValue(c: Configuration, field: string, value: string): string | null {
  const spec = specOf(c, field);
  if (!spec) return `“${field}” is not a target field`;
  if (!value) return isRequired(c, field) ? 'Required value is missing' : null;
  if (spec.format === 'date' && !validDate(value))
    return 'Use a real date in YYYY-MM-DD format (year 1900–2100)';
  const validate = validator(spec);
  return validate(typedValue(value, spec))
    ? null
    : ajv.errorsText(validate.errors, { dataVar: field });
}

export interface Normalized {
  value: string;
  /** Present when more than one interpretation is valid (e.g. 04/05/2024). */
  options?: string[];
  issue?: string;
}
/** Safe, reversible cleanup only: whitespace, casing, unambiguous dates, canonical enum spellings. */
export function normalizeValue(c: Configuration, field: string, input: string): Normalized {
  const spec = specOf(c, field);
  const value = input.trim().replace(/\s+/g, ' ');
  if (!value || !spec) return { value };
  if (spec.format === 'email') return { value: value.toLowerCase() };
  if (spec.format === 'date') return normalizeDate(value);
  if (spec.enum) {
    const wanted = key(value);
    const direct = spec.enum.find((e) => key(String(e)) === wanted);
    const alias = Object.entries(spec['x-value-aliases'] || {}).find(
      ([k]) => key(k) === wanted,
    )?.[1];
    return { value: direct !== undefined ? String(direct) : (alias ?? value) };
  }
  if (spec.type === 'boolean') {
    const lower = value.toLowerCase();
    if (['true', 'yes', 'y'].includes(lower)) return { value: 'true' };
    if (['false', 'no', 'n'].includes(lower)) return { value: 'false' };
  }
  return { value };
}

function normalizeDate(value: string): Normalized {
  if (validDate(value)) return { value };
  const ymd = value.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (ymd) return { value: iso(+ymd[1], +ymd[2], +ymd[3]) || value };
  const numeric = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (numeric) {
    const [, a, b, y] = numeric;
    const options = [...new Set([iso(+y, +b, +a), iso(+y, +a, +b)].filter(Boolean))];
    if (options.length === 1) return { value: options[0] };
    if (options.length === 2)
      return {
        value,
        options,
        issue:
          'Both day/month and month/day are valid. The source does not establish a date convention.',
      };
  }
  return { value };
}

/** The exact JSON object delivered to the target: typed, validated, empty optionals omitted. */
export function buildPayload(c: Configuration, data: Row) {
  const out: Record<string, string | number | boolean> = {};
  for (const [field, value] of Object.entries(data)) {
    if (value === undefined || value === '' || !specOf(c, field)) continue;
    out[field] = typedValue(value, specOf(c, field));
  }
  const problems = fieldNames(c).flatMap((f) => {
    const p = validateValue(c, f, data[f] || '');
    return p ? [`${f}: ${p}`] : [];
  });
  if (problems.length) throw new Error(problems.join('; '));
  return out;
}
