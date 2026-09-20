import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Layers3,
  Loader2,
  LogOut,
  Plus,
  Radio,
  Settings2,
  Sparkles,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { request, setSession, type Session } from './auth';
import { Login } from './Login';
import type { History, ReviewCase, Run, SettingsResponse, User } from './types';
import { Badge, Empty, Modal, statusLabel } from './ui';
import { NewMigration } from './views/NewMigration';
import { RunView } from './views/RunView';
import { SettingsPanel } from './views/Settings';
import { TargetMonitor } from './views/TargetMonitor';

export function App() {
  const [session, updateSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true);
  function signedIn(value: Session | null) {
    setSession(value);
    updateSession(value);
  }
  useEffect(() => {
    let alive = true;
    void fetch('/api/auth/me')
      .then(async (r) => {
        if (r.ok && alive) signedIn(await r.json());
      })
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    const expire = () => signedIn(null);
    window.addEventListener('relay-session-expired', expire);
    return () => {
      alive = false;
      window.removeEventListener('relay-session-expired', expire);
    };
  }, []);
  if (loading)
    return (
      <Empty title="Opening workspace" icon={<Loader2 className="spin" />}>
        Checking your session…
      </Empty>
    );
  return session ? (
    <Workspace
      key={session.user.id}
      user={session.user}
      logout={() => {
        void request('/api/auth/logout', { method: 'POST' })
          .catch(() => undefined)
          .finally(() => signedIn(null));
      }}
    />
  ) : (
    <Login onLogin={signedIn} />
  );
}

type Dialog = null | 'settings' | 'target' | 'team' | 'account';

function Workspace({ user, logout }: { user: User; logout: () => void }) {
  const isAdmin = user.role === 'admin';
  const [run, setRun] = useState<Run | null>(null);
  const [runId, setRunId] = useState<string | null>(() =>
    localStorage.getItem(`relay-run:${user.id}`),
  );
  const [history, setHistory] = useState<History>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    if (!isAdmin) return;
    void request<User[]>('/api/users')
      .then(setUsers)
      .catch((e) => setError(e.message));
    void request<SettingsResponse>('/api/settings')
      .then(setSettings)
      .catch((e) => setError(e.message));
  }, [isAdmin]);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [h, r] = await Promise.all([
          request<History>('/api/runs'),
          runId ? request<Run>(`/api/runs/${runId}`) : Promise.resolve(null),
        ]);
        if (!alive) return;
        setHistory(h);
        // Never let a slower, older poll overwrite a newer local update.
        setRun((current) =>
          current && r && current.id === r.id && (current.revision || 0) > (r.revision || 0)
            ? current
            : r,
        );
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          if (runId) select(null);
        }
      }
    };
    void poll();
    const interval = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [runId]);

  function select(id: string | null) {
    setRunId(id);
    setRun(null);
    setError('');
    if (id) localStorage.setItem(`relay-run:${user.id}`, id);
    else localStorage.removeItem(`relay-run:${user.id}`);
  }
  async function resolve(item: ReviewCase, action: string, value?: string, reason?: string) {
    if (!run) return;
    setRun(
      await request<Run>(`/api/runs/${run.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId: item.id,
          expectedRevision: run.revision || 0,
          decision: { action, reason, ...(value === undefined ? {} : { value }) },
        }),
      }),
    );
  }

  const openDecisions = history.reduce((n, h) => n + h.pending, 0);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => select(null)} aria-label="Relay home">
          <span className="brand-icon">
            <Layers3 size={24} />
          </span>
          relay<span className="brand-dot">.</span>
        </button>
        <div className="workspace-card">
          <span className="company-avatar">R</span>
          <div>
            <strong>Relay Operations</strong>
            <small>Data migrations</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <p className="nav-label">Workspace</p>
        <button className={`nav-item ${!runId ? 'active' : ''}`} onClick={() => select(null)}>
          <Layers3 size={18} /> {isAdmin ? 'Migrations' : 'Assigned to me'}
          <span className="nav-count">{isAdmin ? history.length : openDecisions}</span>
        </button>
        {isAdmin && (
          <>
            <button className="nav-item" onClick={() => setDialog('target')}>
              <Radio size={18} /> Mock target
            </button>
            <button className="nav-item" onClick={() => setDialog('settings')}>
              <Sparkles size={18} /> AI &amp; alerts
              {settings && (
                <span
                  className={`dot ${settings.ai.configured ? 'on' : 'off'}`}
                  aria-label={settings.ai.configured ? 'AI configured' : 'AI not configured'}
                />
              )}
            </button>
            <button className="nav-item" onClick={() => setDialog('team')}>
              <Users size={18} /> Team access
            </button>
          </>
        )}
        <div className="recent-heading">
          <p className="nav-label">Recent migrations</p>
          {isAdmin && (
            <button className="icon-btn" aria-label="New migration" onClick={() => select(null)}>
              <Plus size={16} />
            </button>
          )}
        </div>
        <div className="history">
          {history.slice(0, 6).map((h) => (
            <button
              key={h.id}
              className={`history-item ${runId === h.id ? 'selected' : ''}`}
              onClick={() => select(h.id)}
            >
              <span className={`status-dot ${h.status}`} />
              <span>
                {h.name}
                <small>{h.records ? `${h.records} records` : statusLabel[h.status]}</small>
              </span>
            </button>
          ))}
          {!history.length && (
            <p className="muted small sidebar-hint">Your migrations will appear here.</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button className="profile account-button" onClick={() => setDialog('account')}>
            <span className="avatar">
              {user.name
                .split(' ')
                .map((n) => n[0])
                .slice(0, 2)
                .join('')}
            </span>
            <div>
              <strong>{user.name}</strong>
              <small>{isAdmin ? 'Administrator' : 'Implementation consultant'}</small>
            </div>
          </button>
          <button className="nav-item" onClick={() => setDialog('account')}>
            <Settings2 size={17} /> Account settings
          </button>
          <button className="nav-item" onClick={logout}>
            <LogOut size={17} /> Sign out
          </button>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace <ChevronRight size={14} /> <span>Migrations</span>
            {run && (
              <>
                <ChevronRight size={14} />
                <span className="breadcrumb-current">{run.id.slice(0, 8)}</span>
              </>
            )}
          </div>
          <span className="environment">
            <UserRound size={14} /> {isAdmin ? 'Administrator' : 'Implementation consultant'}
          </span>
        </header>
        <main>
          {error && (
            <div className="error-banner" role="alert">
              <CircleAlert size={18} />
              <span>{error}</span>
              <button className="icon-btn" aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {!run && runId ? (
            <Empty icon={<Loader2 className="spin" />} title="Opening migration">
              Loading the saved workspace…
            </Empty>
          ) : run ? (
            <RunView
              key={run.id}
              run={run}
              user={user}
              users={users}
              setRun={setRun}
              setError={setError}
              close={() => select(null)}
              resolve={resolve}
              openTarget={() => setDialog('target')}
            />
          ) : isAdmin ? (
            <>
              <NewMigration
                users={users}
                ai={settings?.ai ?? null}
                openSettings={() => setDialog('settings')}
                setError={setError}
                onCreated={(created) => {
                  select(created.id);
                  setRun(created);
                }}
              />
              {!!history.length && <MigrationRegister history={history} open={select} />}
            </>
          ) : (
            <Inbox history={history} open={select} />
          )}
        </main>
      </div>

      {dialog === 'settings' && settings && (
        <Modal title="AI mapping & alerts" close={() => setDialog(null)} wide>
          <SettingsPanel settings={settings} onChange={setSettings} />
        </Modal>
      )}
      {dialog === 'target' && (
        <Modal title="Relay mock target" close={() => setDialog(null)} wide>
          <TargetMonitor />
        </Modal>
      )}
      {dialog === 'team' && (
        <Modal title="Team access" close={() => setDialog(null)}>
          <p className="muted">
            Administrators create migrations and control recovery. Consultants review only the
            migrations escalated to them.
          </p>
          <div className="team-list">
            {users.map((u) => (
              <div key={u.id}>
                <span className="avatar">
                  {u.name
                    .split(' ')
                    .map((n) => n[0])
                    .join('')}
                </span>
                <div>
                  <strong>{u.name}</strong>
                  <p>{u.email}</p>
                </div>
                <Badge tone={u.role === 'admin' ? 'purple' : 'green'}>
                  {u.role === 'admin' ? 'Administrator' : 'Consultant'}
                </Badge>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {dialog === 'account' && (
        <Modal title="Account settings" close={() => setDialog(null)}>
          <p className="muted">
            {user.name} · {user.email}
          </p>
          <PasswordForm logout={logout} />
        </Modal>
      )}
    </div>
  );
}

function Inbox({ history, open }: { history: History; open: (id: string) => void }) {
  return (
    <section className="inbox">
      <div className="page-heading">
        <div>
          <h1>Assigned to you</h1>
          <p>Migrations the agent has escalated to you, with the reason it stopped.</p>
        </div>
        <Badge>{history.reduce((n, h) => n + h.pending, 0)} open decisions</Badge>
      </div>
      {history.length ? (
        <div className="panel table-scroll">
          <table>
            <thead>
              <tr>
                <th>Migration</th>
                <th>Status</th>
                <th>Records</th>
                <th>Decisions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>
                    <strong>{h.name}</strong>
                  </td>
                  <td>
                    <Badge tone={h.pending ? 'amber' : 'green'}>{statusLabel[h.status]}</Badge>
                  </td>
                  <td>{h.records}</td>
                  <td>{h.pending}</td>
                  <td>
                    <button className="button" onClick={() => open(h.id)}>
                      Open migration
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon={<Users />} title="Nothing escalated to you">
          When the agent is unsure about a migration assigned to you, it will appear here.
        </Empty>
      )}
    </section>
  );
}

function MigrationRegister({ history, open }: { history: History; open: (id: string) => void }) {
  return (
    <section className="panel recent-table register">
      <div className="panel-heading">
        <h2>Migration register</h2>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Migration</th>
              <th>Escalation contact</th>
              <th>Status</th>
              <th>Open decisions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>
                  <strong>{h.name}</strong>
                </td>
                <td>{h.assignee}</td>
                <td>{statusLabel[h.status]}</td>
                <td>{h.pending}</td>
                <td>
                  <button className="button" onClick={() => open(h.id)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PasswordForm({ logout }: { logout: () => void }) {
  const [currentPassword, setCurrent] = useState(''),
    [newPassword, setNew] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="account-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        void request('/api/auth/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        })
          .then(logout)
          .catch((err) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor="current-password">Current password</label>
      <input
        id="current-password"
        type="password"
        autoComplete="current-password"
        required
        value={currentPassword}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <label htmlFor="new-password">New password</label>
      <input
        id="new-password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
        value={newPassword}
        onChange={(e) => setNew(e.target.value)}
      />
      <p className="field-hint">
        At least 12 characters. Changing your password signs out every session.
      </p>
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      <button className="button primary" disabled={busy}>
        Change password
      </button>
    </form>
  );
}
