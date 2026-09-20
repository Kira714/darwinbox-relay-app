import { useState, type FormEvent } from 'react';
import { Layers3, ArrowRight, Loader2, ShieldCheck, GitBranch, CheckCheck } from 'lucide-react';
import { request, type Session } from './auth';
export function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(
        await request<Session>('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="login-brand">
          <Layers3 size={28} />
          <strong>Relay</strong>
          <span>Operations</span>
        </div>
        <div>
          <h1>
            Employee data.
            <br />
            Every decision accounted for.
          </h1>
          <p>A shared workspace for migration administrators and implementation consultants.</p>
          <ul>
            <li>
              <GitBranch />
              <span>Reconcile multiple exports into one employee directory.</span>
            </li>
            <li>
              <ShieldCheck />
              <span>Route uncertain decisions to the assigned consultant.</span>
            </li>
            <li>
              <CheckCheck />
              <span>Validate, deliver, and keep a complete record of changes.</span>
            </li>
          </ul>
        </div>
        <small>Migration operations</small>
      </section>
      <section className="login-panel">
        <form onSubmit={(e) => void submit(e)}>
          <h2>Sign in to Relay</h2>
          <p>Use your workspace account to continue.</p>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary wide" disabled={busy}>
            {busy ? <Loader2 className="spin" size={17} /> : <ArrowRight size={17} />} Sign in
          </button>
          <small>Access is determined by your role and migration assignment.</small>
        </form>
      </section>
    </main>
  );
}
