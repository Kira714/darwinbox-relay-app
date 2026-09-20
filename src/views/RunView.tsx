import { useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bot,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  Database,
  FileSpreadsheet,
  GitBranch,
  LayoutDashboard,
  Loader2,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  UserRoundCog,
  Users,
} from 'lucide-react';
import { request } from '../auth';
import type { RecordRow, ReviewCase, Run, User } from '../types';
import { Badge, busyStatuses, label, Modal, Stat, statusLabel, time } from '../ui';
import { ReviewQueue } from './Review';
import { RecordDetail, Records } from './Records';

type View = 'overview' | 'review' | 'records' | 'mappings' | 'activity';

export function RunView({
  run,
  user,
  users,
  setRun,
  setError,
  close,
  resolve,
  openTarget,
}: {
  run: Run;
  user: User;
  users: User[];
  setRun: (run: Run) => void;
  setError: (message: string) => void;
  close: () => void;
  resolve: (item: ReviewCase, action: string, value?: string, reason?: string) => Promise<void>;
  openTarget: () => void;
}) {
  const isAdmin = user.role === 'admin';
  const [view, setView] = useState<View>(run.cases.length ? 'review' : 'overview');
  const [busy, setBusy] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [detail, setDetail] = useState<RecordRow | null>(null);
  const cfg = run.configuration;
  const dest = cfg.destination;
  const processing = busyStatuses.includes(run.status);
  const rows = run.records;
  const delivered = rows.filter((r) => r.state === 'delivered').length;
  const ready = rows.filter((r) => !['review', 'excluded'].includes(r.state)).length;
  const reviewCount = run.cases.length;
  const totalRows = run.sources.reduce((n, s) => n + s.rows.length, 0);
  const needsPerson = ['review', 'partial', 'error', 'rollback_conflict'].includes(run.status);

  async function action(name: 'retry' | 'rollback' | 'resume') {
    setBusy(true);
    setError('');
    try {
      await request(`/api/runs/${run.id}/${name}`, { method: 'POST' });
      setConfirmRollback(false);
      setRun({ ...run, status: name === 'rollback' ? 'rolling_back' : 'delivering' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const tabs: { id: View; name: string; icon: React.ReactNode }[] = [
    { id: 'overview', name: 'Overview', icon: <LayoutDashboard size={16} /> },
    { id: 'review', name: 'Review queue', icon: <CircleAlert size={16} /> },
    { id: 'records', name: 'Records', icon: <Users size={16} /> },
    { id: 'mappings', name: 'Field mappings', icon: <GitBranch size={16} /> },
    { id: 'activity', name: 'Audit trail', icon: <Activity size={16} /> },
  ];
  const aiLine =
    run.ai?.status === 'used'
      ? `AI mapping · ${run.ai.servedBy || run.ai.model} · ${run.ai.columnsSent} columns${run.ai.sharedSamples ? '' : ' (shapes only)'}`
      : run.ai?.status === 'failed'
        ? 'AI unavailable — known aliases only'
        : 'AI not configured — known aliases only';

  return (
    <>
      <div className="page-heading run-heading">
        <div>
          <h1>{run.name}</h1>
          <p>
            {run.sources.length} sources <span className="dot-separator">·</span>{' '}
            {Object.keys(cfg.schema.properties).length} target fields{' '}
            <span className="dot-separator">·</span> →{' '}
            {dest.kind === 'http' ? new URL(dest.url).host : 'Relay mock API'}{' '}
            <span className="dot-separator">·</span> Started{' '}
            {new Date(run.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </p>
        </div>
        <div className="heading-actions">
          <button className="button" onClick={close}>
            <Plus size={15} /> {isAdmin ? 'New migration' : 'Assigned migrations'}
          </button>
          <a className="button" href={`/api/runs/${run.id}/audit`}>
            <ArrowDownToLine size={15} /> Export audit
          </a>
        </div>
      </div>

      {run.escalation && needsPerson ? (
        <section className="escalation" role="alert">
          <span className="banner-icon">
            <UserRoundCog size={22} />
          </span>
          <div>
            <strong>
              {run.escalation.assignee
                ? `Escalated to ${run.escalation.assignee}`
                : 'Needs a person'}
              : {run.escalation.headline}
            </strong>
            <ul>
              {run.escalation.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
            <small>
              Safe changes are already applied and nothing more is sent until this is resolved.
              {run.escalation.webhook === 'sent' &&
                ' A notification was posted to the escalation webhook.'}
              {run.escalation.webhook === 'failed' &&
                ' The escalation webhook could not be reached.'}
            </small>
          </div>
          {run.status === 'review' && (
            <button className="button banner-button" onClick={() => setView('review')}>
              Review decisions <ArrowRight size={15} />
            </button>
          )}
          {isAdmin && run.status === 'partial' && (
            <button
              className="button banner-button"
              disabled={busy}
              onClick={() => void action('retry')}
            >
              <RotateCcw size={15} /> Retry outstanding
            </button>
          )}
        </section>
      ) : (
        <div
          className={`status-banner ${needsPerson ? 'attention' : ''} ${run.status === 'error' ? 'danger' : ''}`}
        >
          <span className="banner-icon">
            {processing ? (
              <Loader2 size={21} className="spin" />
            ) : run.status === 'completed' || run.status === 'rolled_back' ? (
              <CheckCheck size={21} />
            ) : (
              <Bot size={22} />
            )}
          </span>
          <div>
            <strong>{statusLabel[run.status]}</strong>
            <p>
              {run.status === 'completed'
                ? `All eligible records reached ${dest.kind === 'http' ? new URL(dest.url).host : 'the mock API'}. Source lineage and every decision are saved.`
                : run.status === 'rolled_back'
                  ? 'This migration’s target writes were undone. The audit trail remains available.'
                  : run.status === 'error'
                    ? run.error
                    : run.status === 'rollback_conflict'
                      ? 'Some target changes could not be restored. Inspect record errors and retry.'
                      : 'The agent is mapping columns, cleaning and validating values, then delivering. Follow each step below.'}
            </p>
          </div>
          {isAdmin && run.status === 'error' && (
            <button className="button" disabled={busy} onClick={() => void action('resume')}>
              Resume migration
            </button>
          )}
        </div>
      )}

      <div className="assignment-bar">
        <Users size={16} />
        <span>Escalations go to</span>
        {isAdmin ? (
          <select
            aria-label="Reassign consultant"
            value={run.assignedTo || ''}
            disabled={processing || busy}
            onChange={(e) => {
              setBusy(true);
              void request<Run>(`/api/runs/${run.id}/assign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  assignedTo: e.target.value,
                  expectedRevision: run.revision,
                }),
              })
                .then(setRun)
                .catch((err) => setError(err.message))
                .finally(() => setBusy(false));
            }}
          >
            <option value="" disabled>
              Unassigned
            </option>
            {users
              .filter((u) => u.role === 'ic' && u.active)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        ) : (
          <strong>{user.name}</strong>
        )}
        <small>{Object.keys(run.decisions).length} decisions recorded</small>
      </div>

      <div className="stats-grid">
        <Stat
          title="Source rows"
          value={totalRows}
          icon={<FileSpreadsheet size={18} />}
          note={`Across ${run.sources.length} source files`}
        />
        <Stat
          title="Reconciled records"
          value={rows.length}
          icon={<Users size={18} />}
          note={
            rows.length
              ? `${Math.max(0, totalRows - rows.length)} overlapping rows combined`
              : 'Waiting for field mappings'
          }
        />
        <Stat
          title="Needs a person"
          value={reviewCount}
          icon={<CircleAlert size={18} />}
          note={reviewCount ? 'Only the uncertain decisions' : 'No pending decisions'}
          tone={reviewCount ? 'amber' : ''}
        />
        <Stat
          title="Delivered"
          value={delivered}
          icon={<CheckCheck size={18} />}
          note={`${ready} records passed validation`}
          tone="green"
        />
      </div>

      <div className="tabs" role="tablist" aria-label="Migration views">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={view === tab.id}
            className={view === tab.id ? 'selected' : ''}
            onClick={() => setView(tab.id)}
          >
            {tab.icon}
            {tab.name}
            {tab.id === 'review' && reviewCount > 0 && (
              <span className="tab-count">{reviewCount}</span>
            )}
          </button>
        ))}
      </div>

      <div
        className={`content-grid ${['records', 'mappings', 'activity'].includes(view) ? 'full' : ''}`}
      >
        <div className="primary-content">
          {view === 'overview' && (
            <>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>The migration journey</h2>
                    <p>Autonomous where it’s safe. Supervised where it matters.</p>
                  </div>
                  <Badge tone="purple">
                    <Bot size={12} /> Agent-led
                  </Badge>
                </div>
                <div className="journey">
                  {[
                    { name: 'Ingest', text: `${run.sources.length} sources`, done: true },
                    {
                      name: 'Map & clean',
                      text: `${run.mappings.filter((m) => m.target).length} mapped fields`,
                      done: !['queued', 'mapping'].includes(run.status),
                    },
                    {
                      name: 'Review',
                      text: reviewCount ? `${reviewCount} decisions` : 'All clear',
                      done: !reviewCount && rows.length > 0,
                    },
                    {
                      name: 'Deliver',
                      text: `${delivered} records`,
                      done: run.status === 'completed',
                    },
                  ].map((s, i) => (
                    <div
                      key={s.name}
                      className={`journey-step ${s.done ? 'done' : ''} ${i === 2 && reviewCount ? 'current' : ''}`}
                    >
                      <div className="step-circle">{s.done ? <Check size={15} /> : i + 1}</div>
                      <strong>{s.name}</strong>
                      <small>{s.text}</small>
                    </div>
                  ))}
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      Connected sources <span className="subtle-count">{run.sources.length}</span>
                    </h2>
                    <p>Original data is preserved with row-level lineage.</p>
                  </div>
                  <FileSpreadsheet size={18} className="muted" />
                </div>
                <div className="source-list">
                  {run.sources.map((s) => (
                    <div className="source-row" key={s.id}>
                      <span className="file-icon">
                        <FileSpreadsheet size={21} />
                      </span>
                      <div>
                        <strong>{s.name}</strong>
                        <small>
                          {s.rows.length} rows <span>·</span> {s.headers.length} columns
                        </small>
                      </div>
                      <Badge tone="green">
                        <Check size={11} /> Ingested
                      </Badge>
                    </div>
                  ))}
                </div>
                <button className="panel-footer-button" onClick={() => setView('mappings')}>
                  Inspect field mappings <ArrowRight size={14} />
                </button>
              </section>
              <section className="panel destination-panel">
                <div className="target-icon">
                  <Database size={21} />
                </div>
                <div>
                  <h2>{dest.kind === 'http' ? new URL(dest.url).host : 'Relay mock API'}</h2>
                  <p>
                    {dest.kind === 'http' ? dest.url : 'Built-in target'} · identity{' '}
                    <code>{cfg.identityField}</code> · idempotent JSON POST
                  </p>
                </div>
                {isAdmin && dest.kind === 'reference' ? (
                  <button className="button" onClick={openTarget}>
                    View received records
                  </button>
                ) : (
                  <Badge tone="green">Connected</Badge>
                )}
              </section>
              {isAdmin &&
                dest.kind === 'reference' &&
                ['completed', 'partial', 'rollback_conflict'].includes(run.status) && (
                  <div className="rollback-box">
                    <div>
                      <strong>Need to undo this migration?</strong>
                      <p>Restore previous target values without changing your source files.</p>
                    </div>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => setConfirmRollback(true)}
                    >
                      <RotateCcw size={14} />{' '}
                      {run.status === 'rollback_conflict' ? 'Retry rollback' : 'Roll back'}
                    </button>
                  </div>
                )}
            </>
          )}
          {view === 'review' && <ReviewQueue run={run} resolve={resolve} />}
          {view === 'records' && <Records run={run} open={setDetail} />}
          {view === 'mappings' && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Source-to-target mappings</h2>
                  <p>{aiLine}. Confidence is the model’s own estimate, not a probability.</p>
                </div>
                <Badge>{run.mappings.length} columns</Badge>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Source column</th>
                      <th>Target field</th>
                      <th>Decision</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.mappings.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <strong>{m.column}</strong>
                          <small>{run.sources.find((s) => s.id === m.sourceId)?.name}</small>
                        </td>
                        <td>
                          {m.target ? (
                            <code>{m.target}</code>
                          ) : (
                            <span className="muted">
                              {m.method === 'ignored' ? 'Not migrated' : 'Awaiting decision'}
                            </span>
                          )}
                        </td>
                        <td>
                          <Badge
                            tone={
                              m.method === 'pending'
                                ? 'amber'
                                : m.method === 'ai'
                                  ? 'purple'
                                  : 'green'
                            }
                          >
                            {m.method === 'alias'
                              ? 'Known alias'
                              : m.method === 'ai'
                                ? `AI${m.confidence != null ? ` ${Math.round(m.confidence * 100)}%` : ''}`
                                : m.method === 'human'
                                  ? 'Person'
                                  : m.method === 'ignored'
                                    ? 'Ignored'
                                    : 'Needs review'}
                          </Badge>
                        </td>
                        <td className="evidence">
                          {m.reason}
                          {m.method === 'pending' && (
                            <button className="text-button" onClick={() => setView('review')}>
                              Resolve mapping <ChevronRight size={12} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {view === 'activity' && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>A clear record of everything that happened</h2>
                  <p>Persisted events with reasons, changes and who decided.</p>
                </div>
                <Badge>{run.events.length} events</Badge>
              </div>
              <div className="full-events">
                {[...run.events].reverse().map((e) => (
                  <div className="full-event" key={e.id}>
                    <span className={`event-icon ${e.kind}`}>
                      {e.kind === 'human' ? (
                        <Users size={15} />
                      ) : e.kind === 'integration' ? (
                        <Database size={15} />
                      ) : (
                        <Bot size={15} />
                      )}
                    </span>
                    <div>
                      <div className="event-title">
                        <strong>{e.title}</strong>
                        {e.actor && (
                          <span className="actor-label">
                            {e.actor.name} ·{' '}
                            {e.actor.role === 'admin' ? 'Administrator' : 'Consultant'}
                          </span>
                        )}
                        <Badge>{label(e.kind)}</Badge>
                        <time>{time(e.at)}</time>
                      </div>
                      <p>{e.detail}</p>
                      {!!e.after && typeof e.after === 'object' && 'reason' in e.after && (
                        <p className="review-rationale">
                          <strong>Decision reason:</strong> {String(e.after.reason)}
                        </p>
                      )}
                      {(e.before !== undefined || e.after !== undefined) && (
                        <details>
                          <summary>View change details</summary>
                          <pre>{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
        {(view === 'overview' || view === 'review') && (
          <aside className="activity-rail">
            <section className="panel agent-panel">
              <div className="agent-title">
                <span className="bot-avatar">
                  <Bot size={20} />
                </span>
                <div>
                  <strong>Your migration agent</strong>
                  <small>
                    <span className={`status-dot ${processing ? 'mapping' : 'completed'}`} />
                    {processing
                      ? 'Working on your data'
                      : reviewCount
                        ? 'Waiting for a person'
                        : 'Work saved'}
                  </small>
                </div>
              </div>
              <div className="agent-policy">
                <ShieldCheck size={17} />
                <p>
                  <strong>Safe changes, made for you.</strong> Unclear dates, conflicting values,
                  unfamiliar columns and missing data always come back to a person.
                </p>
              </div>
              <div className={`agent-model ${run.ai?.status === 'used' ? '' : 'off'}`}>
                <Sparkles size={14} />
                <span>{aiLine}</span>
              </div>
            </section>
            <section className="panel activity-panel">
              <div className="panel-heading">
                <h2>Agent activity</h2>
                <span className="live-label">
                  <span className="live-dot" /> Live
                </span>
              </div>
              <div className="event-list">
                {[...run.events]
                  .reverse()
                  .slice(0, 5)
                  .map((e) => (
                    <div className="event" key={e.id}>
                      <span className={`event-dot ${e.kind}`} />
                      <div>
                        <strong>{e.title}</strong>
                        <p>{e.detail}</p>
                        <time>{time(e.at)}</time>
                      </div>
                    </div>
                  ))}
              </div>
              <button className="panel-footer-button" onClick={() => setView('activity')}>
                View full audit trail <ArrowRight size={14} />
              </button>
            </section>
          </aside>
        )}
      </div>

      {confirmRollback && (
        <Modal title="Roll back this migration?" close={() => setConfirmRollback(false)}>
          <p className="muted">
            This restores target values from before this migration, or removes records created by
            this run. If another migration changed a record afterwards, Relay keeps that later work
            and reports a conflict.
          </p>
          <p className="muted">
            Your source files, review decisions and audit trail remain available.
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => setConfirmRollback(false)}>
              Keep migration
            </button>
            <button
              className="button danger-button"
              disabled={busy}
              onClick={() => void action('rollback')}
            >
              <RotateCcw size={15} /> Confirm rollback
            </button>
          </div>
        </Modal>
      )}
      {detail && (
        <Modal
          title={detail.data.full_name || detail.data[cfg.identityField] || 'Record details'}
          close={() => setDetail(null)}
        >
          <RecordDetail run={run} row={detail} />
        </Modal>
      )}
    </>
  );
}
