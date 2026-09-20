import { useState } from 'react';
import {
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  Loader2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { ReviewCase, Run } from '../types';
import { Badge, busyStatuses, Empty, label } from '../ui';

type Resolve = (item: ReviewCase, action: string, value?: string, reason?: string) => Promise<void>;

export function ReviewQueue({ run, resolve }: { run: Run; resolve: Resolve }) {
  const [selected, setSelected] = useState<string | null>(null);
  const item = run.cases.find((c) => c.id === selected) || run.cases[0];
  return (
    <section className="panel review-panel">
      <div className="panel-heading">
        <div>
          <h2>Review exceptions</h2>
          <p>Only what the agent could not safely decide. Record the reason for each decision.</p>
        </div>
        <Badge tone={run.cases.length ? 'amber' : 'green'}>{run.cases.length} pending</Badge>
      </div>
      {!item ? (
        <Empty icon={<CheckCheck size={25} />} title="You’re all caught up">
          {busyStatuses.includes(run.status)
            ? 'Your decisions are saved. The agent is continuing the migration.'
            : 'No unresolved decisions. See the overview for delivery results.'}
        </Empty>
      ) : (
        <>
          <div className="review-selector">
            {run.cases.map((c, i) => (
              <button
                key={c.id}
                onClick={() => setSelected(c.id)}
                className={c.id === item.id ? 'selected' : ''}
              >
                {String(i + 1).padStart(2, '0')}{' '}
                <span>
                  {c.kind === 'mapping'
                    ? c.value
                    : run.records.find((r) => r.id === c.recordId)?.data.full_name ||
                      run.records.find((r) => r.id === c.recordId)?.data[
                        run.configuration.identityField
                      ] ||
                      label(c.kind)}
                </span>
              </button>
            ))}
          </div>
          <ReviewForm key={item.id} item={item} run={run} resolve={resolve} />
        </>
      )}
    </section>
  );
}

function ReviewForm({ item, run, resolve }: { item: ReviewCase; run: Run; resolve: Resolve }) {
  const cfg = run.configuration;
  const fields = Object.keys(cfg.schema.properties);
  const mapping = run.mappings.find((m) => m.id === item.mappingId);
  const [value, setValue] = useState(item.options[0] || '');
  const [custom, setCustom] = useState(!item.options.length);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState('');
  const row = run.records.find((r) => r.id === item.recordId);
  const isDate = !!item.field && cfg.schema.properties[item.field]?.format === 'date';
  const who = row?.data.full_name || row?.data[cfg.identityField];

  async function submit(action: string) {
    setSaving(true);
    setError('');
    try {
      if (reason.trim().length < 8)
        throw new Error('Add a decision reason of at least 8 characters.');
      await resolve(
        item,
        action,
        ['ignore', 'exclude', 'reject'].includes(action) ? undefined : value,
        reason,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="review-form">
      <div className="review-meta">
        <Badge tone="amber">
          {item.kind === 'date'
            ? 'Ambiguous date'
            : item.kind === 'mapping'
              ? 'Column mapping'
              : label(item.kind)}
        </Badge>
        <span>{item.validationAttempts ? '2 validation attempts' : 'Human context required'}</span>
      </div>
      <h3>{item.title}</h3>
      <p className="case-reason">{item.reason}</p>
      {item.kind === 'mapping' && !!mapping?.candidates.length && (
        <div className="ai-suggestion">
          <Sparkles size={15} />
          <div>
            <strong>The agent’s suggestion</strong>
            <div className="chips">
              {mapping.candidates.map((c) => (
                <button
                  key={c.field}
                  className={`chip-button ${value === c.field ? 'selected' : ''}`}
                  onClick={() => setValue(c.field)}
                >
                  {c.field}
                  {c.confidence > 0 && <small>{Math.round(c.confidence * 100)}%</small>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="record-context">
        <span className="avatar purple-avatar">
          {String(who || 'SC')
            .split(' ')
            .map((s) => s[0])
            .slice(0, 2)
            .join('')}
        </span>
        <div>
          <strong>
            {who || 'Source column'} {row && <small>{row.data[cfg.identityField]}</small>}
          </strong>
          <p>{item.context}</p>
        </div>
      </div>
      <div className="source-value">
        <span>VALUE IN SOURCE</span>
        <code>{item.value || '(empty)'}</code>
      </div>
      <label
        className="input-label"
        htmlFor={item.kind === 'mapping' || custom ? 'resolution-value' : undefined}
      >
        {item.kind === 'mapping' ? 'Choose the target field' : 'What should the target value be?'}
      </label>
      {item.kind === 'mapping' ? (
        <select id="resolution-value" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Select a target field…</option>
          {fields.map((f) => (
            <option key={f} value={f}>
              {label(f)}
            </option>
          ))}
        </select>
      ) : (
        <>
          {!!item.options.length && (
            <div className="option-grid">
              {item.options.map((option) => (
                <button
                  key={option}
                  aria-pressed={!custom && value === option}
                  className={`value-option ${!custom && value === option ? 'selected' : ''}`}
                  onClick={() => {
                    setValue(option);
                    setCustom(false);
                  }}
                >
                  <span className="radio-dot" />
                  <strong>
                    {isDate
                      ? new Date(option + 'T00:00:00Z').toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                          timeZone: 'UTC',
                        })
                      : option}
                  </strong>
                  <small>{option}</small>
                </button>
              ))}
            </div>
          )}
          {!!item.options.length && (
            <button
              className="text-button custom-toggle"
              onClick={() => {
                setCustom(!custom);
                setValue(custom ? item.options[0] : '');
              }}
            >
              {custom ? 'Choose a source value instead' : 'Enter a different value'}
            </button>
          )}
          {custom && (
            <input
              id="resolution-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              placeholder={
                isDate
                  ? 'YYYY-MM-DD'
                  : cfg.schema.properties[item.field || '']?.format === 'email'
                    ? 'name@example.com'
                    : 'Enter the confirmed value'
              }
            />
          )}
        </>
      )}
      {error && (
        <div className="inline-error" role="alert">
          <CircleAlert size={15} />
          {error}
        </div>
      )}
      <label className="input-label reason-label" htmlFor="decision-reason">
        Decision reason
      </label>
      <textarea
        id="decision-reason"
        rows={3}
        maxLength={1000}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Record the client evidence or reason for rejecting this record."
      />
      <p className="field-hint">
        Required for every decision. Your name, role, reason, and timestamp are saved.
      </p>
      <div className="decision-note">
        <ShieldCheck size={16} />
        <p>
          Your decision is validated and saved to the audit trail.{' '}
          {item.kind === 'mapping' ? (
            'Next, the agent cleans and validates the records and asks for any record-level context.'
          ) : run.cases.length === 1 ? (
            <strong>This is the last case. Resolving it starts delivery automatically.</strong>
          ) : (
            'Delivery starts automatically once all cases are resolved.'
          )}
        </p>
      </div>
      {reject ? (
        <div className="exclude-confirm">
          <p>
            Reject this record from the migration? All linked source rows stay in the audit trail
            and will not be delivered.
          </p>
          <button className="button" onClick={() => setReject(false)}>
            Keep record
          </button>
          <button
            className="button danger-button"
            disabled={saving}
            onClick={() => void submit('reject')}
          >
            Confirm rejection
          </button>
        </div>
      ) : (
        <div className="review-actions">
          <button
            className="button primary"
            disabled={
              saving ||
              (!value &&
                (cfg.schema.required.includes(item.field || '') || item.kind === 'mapping'))
            }
            onClick={() => void submit(custom || item.kind === 'mapping' ? 'correct' : 'approve')}
          >
            {saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{' '}
            {item.kind === 'mapping'
              ? 'Apply mapping'
              : custom
                ? 'Save correction'
                : 'Approve value'}
          </button>
          <button
            className="text-button muted"
            disabled={saving}
            onClick={() => (item.kind === 'mapping' ? void submit('ignore') : setReject(true))}
          >
            {item.kind === 'mapping' ? 'Ignore this column' : 'Reject record'}
          </button>
        </div>
      )}
      {row && (
        <details className="lineage">
          <summary>
            Inspect original source rows <ChevronDown size={13} />
          </summary>
          {row.lineage.map((l, i) => (
            <div key={i}>
              <p>
                {l.source} · row {l.line}
              </p>
              <pre>{JSON.stringify(l.raw, null, 2)}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
