import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { request } from '../auth';
import { Empty } from '../ui';

type Row = Record<string, unknown>;
const internal = new Set(['_version', '_run', '_at']);

/** Live view of what the built-in mock API has received, plus a switch to make it fail on demand. */
export function TargetMonitor() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    request<Row[]>('/api/mock/records')
      .then(setRows)
      .catch((e: Error) => setNote(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, []);
  const columns = rows
    ? [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !internal.has(k))
    : [];
  return (
    <div className="target-monitor">
      <p className="muted">
        This is the built-in stand-in for the customer's system: <code>POST /api/mock/records</code>
        . Records appear here the moment the agent delivers them.
      </p>
      <div className="settings-actions">
        <button
          className="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void request('/api/mock/fail-next', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ count: 1 }),
            })
              .then(() =>
                setNote(
                  'The next write will fail with HTTP 503 — start a migration to watch it escalate, then use Retry.',
                ),
              )
              .catch((e: Error) => setNote(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <AlertTriangle size={14} />} Fail the
          next write
        </button>
        <button className="button" onClick={() => void load()}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {note && (
        <p className="field-hint" role="status">
          {note}
        </p>
      )}
      {rows && !rows.length ? (
        <Empty title="Nothing received yet" icon={<RefreshCw size={22} />}>
          Delivered records will show up here.
        </Empty>
      ) : (
        <div className="table-scroll target-table">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
                <th>Delivered by</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c}>{String(r[c] ?? '—')}</td>
                  ))}
                  <td>
                    <small>{String(r._run ?? '').slice(0, 8)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && !!rows.length && <p className="table-caption">{rows.length} records</p>}
    </div>
  );
}
