import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  Database,
  FileSpreadsheet,
  Loader2,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { request } from '../auth';
import type { AiInfo, Preset, Run, User } from '../types';
import { Badge } from '../ui';

type Preview = { name: string; rows: number; columns: { name: string; sample: string[] }[] };
type FieldRow = {
  name: string;
  type: string;
  format?: string;
  required: boolean;
  enum?: unknown[];
  description?: string;
};
type Parsed = { fields: FieldRow[]; error?: string };

function parseSchema(text: string): Parsed {
  try {
    const schema = JSON.parse(text);
    if (!schema || typeof schema.properties !== 'object' || Array.isArray(schema.properties))
      return { fields: [], error: 'The schema needs a "properties" object.' };
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    return {
      fields: Object.entries<Record<string, unknown>>(schema.properties).map(([name, p]) => ({
        name,
        type: String(p?.type ?? '?'),
        format: p?.format as string | undefined,
        enum: p?.enum as unknown[] | undefined,
        description: (p?.description as string) || undefined,
        required: required.includes(name),
      })),
    };
  } catch (e) {
    return { fields: [], error: (e as Error).message };
  }
}

const isUrl = (v: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

export function NewMigration({
  users,
  ai,
  onCreated,
  openSettings,
  setError,
}: {
  users: User[];
  ai: AiInfo | null;
  onCreated: (run: Run) => void;
  openSettings: () => void;
  setError: (message: string) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<{
    state: 'idle' | 'loading' | 'ok' | 'error';
    sources: Preview[];
    error?: string;
  }>({
    state: 'idle',
    sources: [],
  });
  const [dragging, setDragging] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState('employee');
  const [schemaText, setSchemaText] = useState('');
  const [showJson, setShowJson] = useState(false);
  const [identityField, setIdentityField] = useState('employee_id');
  const [destKind, setDestKind] = useState<'reference' | 'http'>('reference');
  const [url, setUrl] = useState('');
  const [authorization, setAuthorization] = useState('');
  const [name, setName] = useState('');
  const consultants = users.filter((u) => u.role === 'ic' && u.active);
  const [assignedTo, setAssignedTo] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void request<Preset[]>('/api/presets').then((list) => {
      setPresets(list);
      const first = list[0];
      if (first) {
        setSchemaText(JSON.stringify(first.schema, null, 2));
        setIdentityField(first.identityField);
      }
    });
  }, []);
  useEffect(() => {
    if (!assignedTo && consultants[0]) setAssignedTo(consultants[0].id);
  }, [consultants, assignedTo]);

  // Read the files on the server as soon as they are chosen, so problems show up now.
  useEffect(() => {
    if (!files.length) {
      setPreview({ state: 'idle', sources: [] });
      return;
    }
    let alive = true;
    setPreview((p) => ({ ...p, state: 'loading', error: undefined }));
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    void request<{ sources: Preview[] }>('/api/sources/preview', { method: 'POST', body: form })
      .then((r) => alive && setPreview({ state: 'ok', sources: r.sources }))
      .catch((e: Error) => alive && setPreview({ state: 'error', sources: [], error: e.message }));
    return () => {
      alive = false;
    };
  }, [files]);

  const parsed = useMemo(() => parseSchema(schemaText), [schemaText]);
  const fields = parsed.fields;
  const idCandidates = fields.filter((f) => f.type === 'string');
  useEffect(() => {
    if (idCandidates.length && !idCandidates.some((f) => f.name === identityField))
      setIdentityField((idCandidates.find((f) => f.required) || idCandidates[0]).name);
  }, [schemaText]); // eslint-disable-line react-hooks/exhaustive-deps

  const choosePreset = (id: string) => {
    setPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (preset) {
      setSchemaText(JSON.stringify(preset.schema, null, 2));
      setIdentityField(preset.identityField);
    } else setShowJson(true);
  };
  function addFiles(list: FileList | File[]) {
    const next = [...files];
    for (const f of Array.from(list))
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    setFiles(next);
  }

  const totalRows = preview.sources.reduce((n, s) => n + s.rows, 0);
  const totalColumns = preview.sources.reduce((n, s) => n + s.columns.length, 0);
  const consultant = consultants.find((u) => u.id === assignedTo);
  const missing = [
    preview.state !== 'ok' && 'Add source files that read correctly',
    parsed.error && 'Fix the target schema',
    !parsed.error && !idCandidates.length && 'The schema needs a string field to identify records',
    destKind === 'http' && !isUrl(url) && 'Enter the endpoint URL',
    name.trim().length < 3 && 'Name the migration',
    !assignedTo && 'Choose who receives escalations',
  ].filter(Boolean) as string[];

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('name', name.trim());
      form.append('assignedTo', assignedTo);
      form.append(
        'configuration',
        JSON.stringify({
          schema: JSON.parse(schemaText),
          identityField,
          destination:
            destKind === 'http' ? { kind: 'http', url: url.trim() } : { kind: 'reference' },
        }),
      );
      if (destKind === 'http' && authorization.trim())
        form.append('authorization', authorization.trim());
      files.forEach((f) => form.append('files', f));
      onCreated(await request<Run>('/api/runs', { method: 'POST', body: form }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>New migration</h1>
          <p>
            Upload the source files, say what the target should look like and where it goes, then
            click Generate. The agent does the rest and asks a person only when it is unsure.
          </p>
        </div>
      </div>
      <div className="composer">
        <div className="composer-steps">
          {/* 1 — source files */}
          <section className="panel step">
            <StepHeading
              n={1}
              icon={<Upload size={18} />}
              title="Source files"
              hint="Excel (.xlsx) or CSV. Several files can describe the same records; the agent reconciles them."
            />
            <input
              ref={input}
              type="file"
              accept=".csv,.xlsx"
              multiple
              className="sr-only"
              aria-label="Choose source files"
              onChange={(e) => {
                addFiles(e.target.files || []);
                e.target.value = '';
              }}
            />
            <button
              className={`dropzone compact ${dragging ? 'dragging' : ''}`}
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
            >
              <span className="upload-glyph">
                <FileSpreadsheet size={26} />
                <span>
                  <Plus size={12} />
                </span>
              </span>
              <strong>{files.length ? 'Add more files' : 'Drop Excel or CSV files here'}</strong>
              <span>
                or <em>browse files</em>
              </span>
              <small>2 MB per file · 5,000 rows total</small>
            </button>
            {preview.state === 'loading' && (
              <p className="step-note">
                <Loader2 className="spin" size={14} /> Reading files…
              </p>
            )}
            {preview.state === 'error' && (
              <div className="inline-error" role="alert">
                <CircleAlert size={15} />
                {preview.error}
              </div>
            )}
            {!!files.length && (
              <ul className="file-list">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    <FileSpreadsheet size={15} /> <span>{f.name}</span>{' '}
                    <small>{(f.size / 1024).toFixed(1)} KB</small>
                    <button
                      className="icon-btn"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {preview.state === 'ok' && (
              <div className="preview-grid" aria-label="Detected sheets and columns">
                {preview.sources.map((s) => (
                  <div className="preview-card" key={s.name}>
                    <strong>{s.name}</strong>
                    <small>
                      {s.rows} rows · {s.columns.length} columns
                    </small>
                    <div className="chips">
                      {s.columns.map((c) => (
                        <span key={c.name} title={c.sample.slice(0, 2).join(' · ')}>
                          {c.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 2 — target schema */}
          <section className="panel step">
            <StepHeading
              n={2}
              icon={<Database size={18} />}
              title="Target schema"
              hint="What each record must look like when it reaches the destination."
            />
            <div className="row-fields">
              <label>
                Schema
                <select
                  value={presets.some((p) => p.id === presetId) ? presetId : 'custom'}
                  onChange={(e) => choosePreset(e.target.value)}
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value="custom">Custom JSON Schema</option>
                </select>
              </label>
              <label>
                Identity field
                <select value={identityField} onChange={(e) => setIdentityField(e.target.value)}>
                  {idCandidates.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="field-hint">
              The identity field decides which rows from different files are the same record.
            </p>
            {parsed.error ? (
              <div className="inline-error" role="alert">
                <CircleAlert size={15} />
                Invalid JSON: {parsed.error}
              </div>
            ) : (
              <div className="field-table" role="table" aria-label="Target fields">
                {fields.map((f) => (
                  <div role="row" key={f.name}>
                    <code>{f.name}</code>
                    <span>
                      {f.enum ? f.enum.join(' | ') : f.format ? `${f.type} · ${f.format}` : f.type}
                    </span>
                    <Badge tone={f.required ? 'purple' : 'neutral'}>
                      {f.required ? 'Required' : 'Optional'}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
            <button className="text-button" onClick={() => setShowJson(!showJson)}>
              {showJson ? 'Hide' : 'Edit'} JSON Schema
            </button>
            {showJson && (
              <>
                <textarea
                  className="json-editor"
                  spellCheck={false}
                  rows={14}
                  value={schemaText}
                  aria-label="Target JSON Schema"
                  onChange={(e) => {
                    setSchemaText(e.target.value);
                    setPresetId('custom');
                  }}
                />
                <div className="row-actions">
                  <label className="text-button file-button">
                    Load a .json file
                    <input
                      type="file"
                      accept=".json,application/json"
                      className="sr-only"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (f && f.size < 60000) {
                          setSchemaText(await f.text());
                          setPresetId('custom');
                        }
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <small>
                    Flat properties: string, number, integer, boolean · required · format email/date
                    · enum · min/max · <code>x-aliases</code>
                  </small>
                </div>
              </>
            )}
          </section>

          {/* 3 — destination */}
          <section className="panel step">
            <StepHeading
              n={3}
              icon={<Send size={18} />}
              title="Where to send it"
              hint="Each clean record is POSTed as one JSON object with a stable Idempotency-Key."
            />
            <div className="choice-grid" role="radiogroup" aria-label="Destination">
              <button
                role="radio"
                aria-checked={destKind === 'reference'}
                className={`choice ${destKind === 'reference' ? 'selected' : ''}`}
                onClick={() => setDestKind('reference')}
              >
                <strong>Relay mock API</strong>
                <small>
                  Built in. Supports retry <em>and rollback</em>. Inspect what it received from
                  “Mock target”.
                </small>
              </button>
              <button
                role="radio"
                aria-checked={destKind === 'http'}
                className={`choice ${destKind === 'http' ? 'selected' : ''}`}
                onClick={() => setDestKind('http')}
              >
                <strong>My mock API URL</strong>
                <small>
                  Any HTTP endpoint that accepts a JSON POST (Mockoon, Postman mock, webhook.site…).
                  Retry supported.
                </small>
              </button>
            </div>
            {destKind === 'http' && (
              <div className="stack">
                <label>
                  POST endpoint
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://your-mock-api.example/employees"
                  />
                </label>
                <label>
                  Authorization header <em>(optional)</em>
                  <input
                    type="password"
                    autoComplete="off"
                    value={authorization}
                    onChange={(e) => setAuthorization(e.target.value)}
                    placeholder="Bearer …"
                  />
                </label>
                <p className="field-hint">
                  Stored encrypted and sent only to this endpoint. Nothing is sent until every
                  review case is resolved.
                </p>
              </div>
            )}
          </section>

          {/* 4 — who to escalate to */}
          <section className="panel step">
            <StepHeading
              n={4}
              icon={<Bot size={18} />}
              title="Name it and choose who gets escalations"
              hint="If the agent is unsure or something fails, this person is asked to decide."
            />
            <div className="row-fields">
              <label>
                Migration name
                <input
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Helix consolidation"
                />
              </label>
              <label>
                Escalate to
                <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                  {!consultants.length && <option value="">No consultants available</option>}
                  {consultants.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        </div>

        <aside className="composer-side">
          <section className="panel summary">
            <h2>Ready to generate</h2>
            <ul className="checklist">
              <li className={preview.state === 'ok' ? 'ok' : ''}>
                <Check size={14} />{' '}
                {preview.state === 'ok'
                  ? `${preview.sources.length} sheets · ${totalRows} rows · ${totalColumns} columns`
                  : 'No files yet'}
              </li>
              <li className={!parsed.error && idCandidates.length ? 'ok' : ''}>
                <Check size={14} />{' '}
                {parsed.error
                  ? 'Schema is not valid JSON'
                  : `${fields.length} target fields · ${fields.filter((f) => f.required).length} required`}
              </li>
              <li className={destKind === 'reference' || isUrl(url) ? 'ok' : ''}>
                <Check size={14} />{' '}
                {destKind === 'reference'
                  ? 'Relay mock API'
                  : isUrl(url)
                    ? new URL(url).host
                    : 'Endpoint URL missing'}
              </li>
              <li className={consultant ? 'ok' : ''}>
                <Check size={14} />{' '}
                {consultant ? `Escalations → ${consultant.name}` : 'No escalation contact'}
              </li>
            </ul>
            <div className={`engine ${ai?.configured ? 'on' : 'off'}`}>
              <Sparkles size={16} />
              <div>
                {ai?.configured ? (
                  <>
                    <strong>AI mapping on</strong>
                    <small>
                      {ai.model} via {ai.provider}. Below {Math.round(ai.minConfidence * 100)}%
                      confidence it asks {consultant?.name || 'a person'}.
                    </small>
                  </>
                ) : (
                  <>
                    <strong>AI mapping is off</strong>
                    <small>
                      The agent will only recognise known column names and will ask a person about
                      the rest.
                    </small>
                  </>
                )}
                <button className="text-button" onClick={openSettings}>
                  {ai?.configured ? 'AI settings' : 'Add your OpenRouter key'}{' '}
                  <ArrowRight size={12} />
                </button>
              </div>
            </div>
            <button
              className="button primary wide generate"
              disabled={busy || missing.length > 0}
              onClick={() => void generate()}
            >
              {busy ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />} Generate{' '}
              <ArrowRight size={16} />
            </button>
            {missing.length > 0 && (
              <ul className="missing">
                {missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            <p className="upload-note">
              <ShieldCheck size={13} /> If everything checks out the agent maps, cleans and delivers
              on its own. Otherwise it stops and escalates with a reason — nothing is sent until
              then.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

function StepHeading({
  n,
  icon,
  title,
  hint,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="step-heading">
      <span className="step-number">{n}</span>
      <div>
        <h2>{title}</h2>
        <p>{hint}</p>
      </div>
      <span className="step-icon">{icon}</span>
    </div>
  );
}
