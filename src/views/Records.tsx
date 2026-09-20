import { useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Search } from 'lucide-react';
import type { RecordRow, Run } from '../types';
import { Badge, Empty, label } from '../ui';

export function Records({ run, open }: { run: Run; open: (row: RecordRow) => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const columns = Object.keys(run.configuration.schema.properties).slice(0, 6);
  const rows = run.records.filter(
    (r) =>
      (filter === 'all' || r.state === filter) &&
      Object.values(r.data).some((v) => (v || '').toLowerCase().includes(search.toLowerCase())),
  );
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>The reconciled records</h2>
          <p>Select a record to inspect its source lineage and delivery details.</p>
        </div>
        <div className="heading-actions">
          {!run.cases.length && (
            <a className="button" href={`/api/runs/${run.id}/payload`}>
              <ArrowDownToLine size={14} /> Delivery JSON
            </a>
          )}
          <a className="button" href={`/api/runs/${run.id}/export`}>
            <ArrowDownToLine size={14} /> Clean CSV
          </a>
        </div>
      </div>
      <div className="table-toolbar">
        <div className="search-input">
          <Search size={16} />
          <input
            aria-label="Search records"
            placeholder="Search any value…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter record status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All statuses</option>
          {[
            'ready',
            'review',
            'delivered',
            'failed',
            'excluded',
            'rolled_back',
            'rollback_conflict',
          ].map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((f) => (
                <th key={f}>{label(f)}</th>
              ))}
              <th>Sources</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                {columns.map((f) => (
                  <td key={f}>
                    <button className="employee-button" onClick={() => open(r)}>
                      {r.data[f] || '—'}
                    </button>
                  </td>
                ))}
                <td>
                  <Badge>
                    {r.lineage.length} {r.lineage.length === 1 ? 'row' : 'rows'}
                  </Badge>
                </td>
                <td>
                  <Badge
                    tone={
                      ['review', 'failed', 'rollback_conflict'].includes(r.state)
                        ? 'amber'
                        : ['delivered', 'ready'].includes(r.state)
                          ? 'green'
                          : 'neutral'
                    }
                  >
                    <span className="tiny-dot" />
                    {label(r.state)}
                  </Badge>
                </td>
                <td>
                  <button
                    className="icon-btn"
                    aria-label={`View ${r.data[run.configuration.identityField] || 'record'}`}
                    onClick={() => open(r)}
                  >
                    <ArrowUpRight size={17} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <Empty icon={<Search size={22} />} title="No matching records">
          {run.records.length
            ? 'Try another search or status filter.'
            : 'Records appear after field mappings are resolved.'}
        </Empty>
      )}
      <div className="table-caption">
        {rows.length} of {run.records.length} records <span>Original source values retained</span>
      </div>
    </section>
  );
}

export function RecordDetail({ run, row }: { run: Run; row: RecordRow }) {
  return (
    <>
      <Badge tone={row.state === 'failed' ? 'amber' : 'green'}>{label(row.state)}</Badge>
      {row.error && <div className="inline-error">{row.error}</div>}
      <h3 className="detail-heading">Consolidated values</h3>
      <div className="record-values">
        {Object.keys(run.configuration.schema.properties).map((f) => (
          <div key={f}>
            <span>{label(f)}</span>
            <strong>{row.data[f] || '—'}</strong>
          </div>
        ))}
      </div>
      <h3 className="detail-heading">Original source lineage</h3>
      {row.lineage.map((l, i) => (
        <details className="lineage" open key={i}>
          <summary>
            {l.source} · row {l.line}
          </summary>
          <pre>{JSON.stringify(l.raw, null, 2)}</pre>
        </details>
      ))}
    </>
  );
}
