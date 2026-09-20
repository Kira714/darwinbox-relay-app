import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CircleAlert,
  Database,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { request } from '../auth';
import type { Preset } from '../types';
import { Badge } from '../ui';
import employeeNames from '../../samples/schemas/employee.names.json?raw';
import employeeYaml from '../../samples/schemas/employee.fields.yaml?raw';
import catalogueFields from '../../samples/schemas/catalogue.fields.json?raw';
import crmRecord from '../../samples/schemas/crm.sample-record.json?raw';
import payrollSchema from '../../samples/schemas/payroll.schema.json?raw';

export type FieldInfo = {
  name: string;
  type: string;
  format?: string;
  enum?: unknown[];
  title?: string;
  description?: string;
  required: boolean;
  unique: boolean;
};
export type ResolvedTarget = {
  schema: Record<string, unknown>;
  identityField: string;
  fields: FieldInfo[];
  /** Preset whose sample files exercise this target, if any. */
  samplePreset: string | null;
};
type Validation =
  | { state: 'idle' }
  | { state: 'checking'; previous?: OkResult }
  | { state: 'ok'; result: OkResult }
  | { state: 'error'; error: string };
type OkResult = {
  ok: true;
  kind: string;
  schema: Record<string, unknown>;
  identityField: string;
  identityCandidates: string[];
  warnings: string[];
  fields: FieldInfo[];
};
type Reply = OkResult | { ok: false; error: string };

type Mode = 'preset' | 'build' | 'paste';
type BuildType = 'text' | 'number' | 'integer' | 'boolean' | 'date' | 'email';
type Row = {
  key: number;
  name: string;
  type: BuildType;
  required: boolean;
  description: string;
  /** Preset details a person did not edit (enum, pattern, aliases…) are carried along untouched. */
  extra: Record<string, unknown>;
};

const TYPE_LABEL: Record<BuildType, string> = {
  text: 'Text',
  number: 'Number',
  integer: 'Whole number',
  boolean: 'Yes / No',
  date: 'Date',
  email: 'Email',
};
const KIND_LABEL: Record<string, string> = {
  'json-schema': 'a JSON Schema',
  'field-list': 'a list of fields',
  'field-types': 'field names with types',
  'sample-record': 'a sample record',
  'field-names': 'field names only',
};
const json = { 'Content-Type': 'application/json' };
const NAME_OK = /^[a-zA-Z][a-zA-Z0-9_]{0,119}$/;

const typeProps = (t: BuildType): Record<string, unknown> =>
  t === 'text'
    ? { type: 'string' }
    : t === 'date'
      ? { type: 'string', format: 'date' }
      : t === 'email'
        ? { type: 'string', format: 'email' }
        : { type: t };
const buildTypeOf = (p: { type?: string; format?: string }): BuildType =>
  p.format === 'email'
    ? 'email'
    : p.format === 'date'
      ? 'date'
      : p.type === 'string' || !p.type
        ? 'text'
        : (p.type as BuildType);
const cleanName = (raw: string) => {
  const n = raw
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^\d/.test(n) ? `f_${n}` : n;
};

let nextKey = 1;
function rowsFromSchema(schema: Record<string, unknown>): Row[] {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  return Object.entries(props).map(([name, p]) => {
    const { type, format, description, ...extra } = p;
    return {
      key: nextKey++,
      name,
      type: buildTypeOf({ type: type as string, format: format as string }),
      required: required.includes(name),
      description: typeof description === 'string' ? description : '',
      extra,
    };
  });
}
function schemaFromRows(rows: Row[], identity: string) {
  const usable = rows.filter((r) => NAME_OK.test(r.name));
  return {
    type: 'object',
    additionalProperties: false,
    required: usable.filter((r) => r.required || r.name === identity).map((r) => r.name),
    properties: Object.fromEntries(
      usable.map((r) => [
        r.name,
        {
          ...r.extra,
          ...typeProps(r.type),
          ...(r.description.trim() ? { description: r.description.trim() } : {}),
        },
      ]),
    ),
  };
}

const examples = [
  {
    id: 'names',
    label: 'Just names',
    text: employeeNames,
    preset: 'employee',
    note: 'Names only — types come from the names.',
  },
  {
    id: 'fields',
    label: 'Names + types',
    text: catalogueFields,
    preset: 'catalogue',
    note: '“!” marks a required field.',
  },
  {
    id: 'record',
    label: 'Sample record',
    text: crmRecord,
    preset: 'crm',
    note: 'Types are read from the example values.',
  },
  {
    id: 'schema',
    label: 'JSON Schema',
    text: payrollSchema,
    preset: 'payroll',
    note: 'Full control: required, enums, patterns, limits.',
  },
  { id: 'yaml', label: 'YAML', text: employeeYaml, preset: 'employee', note: 'Same idea in YAML.' },
];

function FieldTable({ fields }: { fields: FieldInfo[] }) {
  return (
    <div className="field-table" role="table" aria-label="Target fields">
      {fields.map((f) => (
        <div role="row" key={f.name}>
          <code>{f.name}</code>
          <span>{f.enum ? f.enum.join(' | ') : f.format ? `${f.type} · ${f.format}` : f.type}</span>
          <Badge tone={f.required ? 'purple' : 'neutral'}>
            {f.required ? 'Required' : 'Optional'}
          </Badge>
        </div>
      ))}
    </div>
  );
}

export function TargetSchemaStep({
  presets,
  onResolved,
}: {
  presets: Preset[];
  onResolved: (target: ResolvedTarget | null) => void;
}) {
  const [mode, setMode] = useState<Mode>('preset');
  const [presetId, setPresetId] = useState('employee');
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState('');
  const [identity, setIdentity] = useState('');
  const [baseSample, setBaseSample] = useState<string | null>(null);
  const [quick, setQuick] = useState('');
  const [quickNote, setQuickNote] = useState('');
  const [showJson, setShowJson] = useState(false);
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const [validation, setValidation] = useState<Validation>({ state: 'idle' });
  const file = useRef<HTMLInputElement>(null);
  const preset = presets.find((p) => p.id === presetId);

  const ok = validation.state === 'ok' ? validation.result : null;
  const shown = ok ?? (validation.state === 'checking' ? validation.previous : undefined);

  // A hint is only sent while it still names a field that can identify records; otherwise the
  // server picks one. (Deleting the ID row must not become an error.)
  const hint =
    mode === 'preset'
      ? preset?.identityField
      : mode === 'build'
        ? rows.some((r) => r.name === identity && (r.type === 'text' || r.type === 'email'))
          ? identity
          : ''
        : shown?.identityCandidates.includes(identity)
          ? identity
          : '';

  // What gets validated depends on the tab; the server is the single judge of what it accepts.
  const input: unknown = useMemo(() => {
    if (mode === 'preset') return preset?.schema ?? null;
    if (mode === 'paste') return text.trim() ? text : null;
    return rows.some((r) => NAME_OK.test(r.name)) ? schemaFromRows(rows, hint ?? '') : null;
  }, [mode, preset, text, rows, hint]);
  const inputKey = JSON.stringify([input, hint]);

  useEffect(() => {
    if (input === null) {
      setValidation({ state: 'idle' });
      return;
    }
    let alive = true;
    setValidation((v) => ({
      state: 'checking',
      previous: v.state === 'ok' ? v.result : v.state === 'checking' ? v.previous : undefined,
    }));
    const timer = setTimeout(() => {
      void request<Reply>('/api/configuration/validate', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ schema: input, ...(hint ? { identityField: hint } : {}) }),
      })
        .then(
          (r) =>
            alive &&
            setValidation(r.ok ? { state: 'ok', result: r } : { state: 'error', error: r.error }),
        )
        .catch((e: Error) => alive && setValidation({ state: 'error', error: e.message }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [inputKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onResolved(
      ok
        ? {
            schema: ok.schema,
            identityField: ok.identityField,
            fields: ok.fields,
            samplePreset: mode === 'preset' ? presetId : baseSample,
          }
        : null,
    );
  }, [validation, mode, presetId, baseSample]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the chosen identity valid as fields change.
  useEffect(() => {
    if (ok && identity && !ok.identityCandidates.includes(identity)) setIdentity('');
  }, [ok]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (key: number, change: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const setType = (r: Row, type: BuildType) =>
    patch(r.key, {
      type,
      // Constraints tied to the old type no longer apply.
      extra: Object.fromEntries(
        Object.entries(r.extra).filter(
          ([k]) =>
            ![
              'enum',
              'pattern',
              'minimum',
              'maximum',
              'minLength',
              'maxLength',
              'x-value-aliases',
            ].includes(k),
        ),
      ),
    });
  const addRow = () => {
    const key = nextKey++;
    setRows((rs) => [
      ...rs,
      { key, name: '', type: 'text', required: false, description: '', extra: {} },
    ]);
    setFocusKey(key);
  };
  const enterBuilder = (from: Record<string, unknown>, id: string, sample: string | null) => {
    setRows(rowsFromSchema(from));
    setIdentity(id);
    setBaseSample(sample);
    setMode('build');
  };
  async function quickAdd() {
    setQuickNote('');
    try {
      const r = await request<Reply>('/api/configuration/validate', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ schema: quick, fieldsOnly: true }),
      });
      if (!r.ok) return setQuickNote(r.error);
      const have = new Set(rows.map((x) => x.name));
      const fresh = rowsFromSchema(r.schema)
        .map((row) => ({ ...row, required: false }))
        .filter((row) => !have.has(row.name));
      setRows((rs) => [...rs.filter((x) => x.name || x.description), ...fresh]);
      setQuick('');
      setQuickNote(
        fresh.length
          ? `Added ${fresh.length} field${fresh.length > 1 ? 's' : ''}. Check the types — they were guessed from the names.`
          : 'Those fields are already in the list.',
      );
    } catch (e) {
      setQuickNote((e as Error).message);
    }
  }
  const nameError = (r: Row) =>
    !r.name
      ? ''
      : !NAME_OK.test(r.name)
        ? 'Use letters, digits and underscores, starting with a letter.'
        : rows.filter((x) => x.name === r.name).length > 1
          ? 'This name is used twice.'
          : '';

  const tabs: { id: Mode; label: string }[] = [
    { id: 'preset', label: 'Ready-made' },
    { id: 'build', label: 'Build fields' },
    { id: 'paste', label: 'Paste or upload' },
  ];
  const candidates = shown?.identityCandidates ?? [];

  return (
    <>
      <div className="mode-tabs" role="tablist" aria-label="How to define the target">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={mode === t.id}
            className={mode === t.id ? 'selected' : ''}
            onClick={() => {
              if (t.id === 'build' && !rows.length)
                enterBuilder(
                  ok?.schema ?? preset?.schema ?? { properties: {} },
                  ok?.identityField ?? '',
                  mode === 'preset' ? presetId : baseSample,
                );
              else if (t.id === 'paste' && !text.trim() && ok)
                setText(JSON.stringify(ok.schema, null, 2));
              setMode(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mode === 'preset' && (
        <>
          <div className="preset-grid" role="radiogroup" aria-label="Ready-made targets">
            {presets.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={presetId === p.id}
                className={`choice ${presetId === p.id ? 'selected' : ''}`}
                onClick={() => setPresetId(p.id)}
              >
                <strong>{p.name}</strong>
                <small>{p.description}</small>
              </button>
            ))}
          </div>
          <p className="field-hint">
            Each one comes with sample files you can load in step 1. Want to change it?{' '}
            <button
              className="text-button inline"
              onClick={() => enterBuilder(preset!.schema, preset!.identityField, presetId)}
            >
              Customize these fields
            </button>
          </p>
        </>
      )}

      {mode === 'build' && (
        <div className="builder">
          <p className="field-hint">
            List the fields the target expects. Names are enough — pick a type and mark what must
            always be present.
          </p>
          <div className="builder-head" aria-hidden="true">
            <span>Field name</span>
            <span>Type</span>
            <span>Required</span>
            <span title="Identifies each record">ID</span>
            <span />
          </div>
          {rows.map((r) => {
            const err = nameError(r);
            const isId = r.name && r.name === (ok?.identityField ?? identity);
            return (
              <div className={`builder-row ${err ? 'invalid' : ''}`} key={r.key}>
                <input
                  aria-label="Field name"
                  value={r.name}
                  autoFocus={focusKey === r.key}
                  placeholder="e.g. employee_id"
                  spellCheck={false}
                  onChange={(e) => patch(r.key, { name: e.target.value })}
                  onBlur={(e) => {
                    const cleaned = NAME_OK.test(e.target.value.trim())
                      ? e.target.value.trim()
                      : cleanName(e.target.value);
                    if (cleaned !== r.name) patch(r.key, { name: cleaned });
                  }}
                />
                <select
                  aria-label="Field type"
                  value={r.type}
                  onChange={(e) => setType(r, e.target.value as BuildType)}
                >
                  {(Object.keys(TYPE_LABEL) as BuildType[]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  role="switch"
                  aria-checked={r.required || !!isId}
                  aria-label={`${r.name || 'Field'} is required`}
                  className={`switch ${r.required || isId ? 'on' : ''}`}
                  disabled={!!isId}
                  title={
                    isId ? 'The field that identifies each record is always required' : undefined
                  }
                  onClick={() => patch(r.key, { required: !r.required })}
                >
                  <span />
                </button>
                <button
                  type="button"
                  className={`id-button ${isId ? 'on' : ''}`}
                  aria-label={`${r.name || 'Field'} identifies each record`}
                  aria-pressed={!!isId}
                  disabled={!(r.type === 'text' || r.type === 'email') || !NAME_OK.test(r.name)}
                  title={
                    r.type === 'text' || r.type === 'email'
                      ? 'Use this field to tell records apart'
                      : 'Only text or email fields can identify a record'
                  }
                  onClick={() => setIdentity(r.name)}
                >
                  <KeyRound size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${r.name || 'field'}`}
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                >
                  <Trash2 size={15} />
                </button>
                <input
                  className="row-description"
                  aria-label={`Description of ${r.name || 'field'}`}
                  value={r.description}
                  placeholder="What is this field? (optional — helps the AI match columns)"
                  onChange={(e) => patch(r.key, { description: e.target.value })}
                />
                {err && <p className="row-error">{err}</p>}
              </div>
            );
          })}
          <div className="builder-actions">
            <button className="button" onClick={addRow}>
              <Plus size={14} /> Add field
            </button>
            <div className="quick-add">
              <input
                aria-label="Add several fields by name"
                value={quick}
                placeholder="or type names: employee_id, name, email, salary"
                onChange={(e) => setQuick(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && quick.trim() && void quickAdd()}
              />
              <button className="button" disabled={!quick.trim()} onClick={() => void quickAdd()}>
                Add
              </button>
            </div>
          </div>
          {quickNote && (
            <p className="field-hint" role="status">
              {quickNote}
            </p>
          )}
        </div>
      )}

      {mode === 'paste' && (
        <div className="paste">
          <p className="field-hint">
            Paste anything from a list of field names to a full JSON Schema — JSON or YAML. Names
            alone work: <code>employee_id, name, email</code>.
          </p>
          <textarea
            className="json-editor"
            spellCheck={false}
            rows={10}
            aria-label="Target definition"
            value={text}
            placeholder={
              '["employee_id", "full_name", "email", "start_date"]\n\nor  { "sku": "string!", "price": "number!", "stock": "whole number" }\nor  a sample record, or a JSON Schema'
            }
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row-actions">
            <button className="button" onClick={() => file.current?.click()}>
              <Upload size={14} /> Upload a file
            </button>
            <input
              ref={file}
              type="file"
              accept=".json,.yaml,.yml,.txt,application/json"
              className="sr-only"
              aria-label="Choose a definition file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f && f.size < 60_000) {
                  setText(await f.text());
                  setBaseSample(null);
                }
                e.target.value = '';
              }}
            />
            <span className="examples">
              Try an example:
              {examples.map((x) => (
                <button
                  key={x.id}
                  className="chip-button"
                  title={x.note}
                  onClick={() => {
                    setText(x.text);
                    setBaseSample(x.preset);
                    setIdentity('');
                  }}
                >
                  {x.label}
                </button>
              ))}
            </span>
          </div>
        </div>
      )}

      {/* what the server understood */}
      {validation.state === 'error' && (
        <div className="inline-error" role="alert">
          <CircleAlert size={15} />
          {validation.error}
        </div>
      )}
      {validation.state === 'idle' && mode !== 'preset' && (
        <p className="field-hint">
          {mode === 'build' ? 'Add at least one field to continue.' : 'Nothing entered yet.'}
        </p>
      )}
      {shown && validation.state !== 'error' && (
        <div className="understood" aria-live="polite">
          <div className="understood-head">
            {validation.state === 'checking' ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Check size={15} />
            )}
            <strong>
              {mode === 'build'
                ? `${shown.fields.length} fields`
                : `Understood as ${KIND_LABEL[shown.kind] ?? shown.kind} · ${shown.fields.length} fields`}
            </strong>
            <span>· {shown.fields.filter((f) => f.required).length} required</span>
            <label className="identity-pick">
              <KeyRound size={13} /> Identifies each record
              <select
                aria-label="Identity field"
                value={shown.identityField}
                onChange={(e) => setIdentity(e.target.value)}
              >
                {candidates.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {shown.warnings.length > 0 && (
            <ul className="warnings">
              {shown.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {mode !== 'build' && <FieldTable fields={shown.fields} />}
          {mode === 'paste' && (
            <button
              className="text-button"
              onClick={() => enterBuilder(shown.schema, shown.identityField, baseSample)}
            >
              Edit these as fields <Database size={12} />
            </button>
          )}
          <button className="text-button" onClick={() => setShowJson(!showJson)}>
            {showJson ? 'Hide' : 'Show'} the JSON Schema that will be used
          </button>
          {showJson && <pre className="contract-json">{JSON.stringify(shown.schema, null, 2)}</pre>}
        </div>
      )}
    </>
  );
}
