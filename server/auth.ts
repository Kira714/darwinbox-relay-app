import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Express, Request, Response, NextFunction } from 'express';
import type { Store } from './store.js';
import { TargetError } from './target.js';
export type Role = 'admin' | 'ic';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
}
interface Auth {
  user: User;
  tokenHash: string;
  csrf: string;
}
declare global {
  namespace Express {
    interface Request {
      auth?: Auth;
    }
  }
}
const derive = promisify(scrypt);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
async function verify(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  const actual = (await derive(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function userFrom(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: row.role as Role,
    active: !!row.active,
  };
}
export async function seedUser(
  store: Store,
  email: string,
  name: string,
  role: Role,
  password: string,
) {
  const existing = store.db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase());
  if (existing) return userFrom(existing);
  const id = randomUUID();
  store.db
    .prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 1)')
    .run(id, email.toLowerCase(), name, role, await hashPassword(password));
  return { id, email: email.toLowerCase(), name, role, active: true };
}
export const actor = (req: Request) => req.auth!.user;
export function admin(req: Request, _res: Response, next: NextFunction) {
  if (actor(req).role !== 'admin')
    throw new TargetError(403, 'Administrator permission is required.');
  next();
}
export function canRead(user: User, run: { assignedTo?: string }) {
  return user.role === 'admin' || run.assignedTo === user.id;
}
function token(req: Request) {
  return (
    req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('relay_session='))
      ?.slice(14) || ''
  );
}
const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.COOKIE_SECURE === 'true',
  path: '/',
};
export function installAuth(app: Express, store: Store, serviceToken: string) {
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = z
      .object({ email: z.email().max(254), password: z.string().min(1).max(200) })
      .strict()
      .parse(req.body);
    const key = `${req.ip}:${email.toLowerCase()}`;
    const blocked = store.db.prepare('SELECT * FROM login_limits WHERE key=?').get(key);
    if (blocked && Number(blocked.until) > Date.now() && Number(blocked.attempts) >= 8)
      throw new TargetError(429, 'Too many login attempts. Try again in 15 minutes.');
    const row = store.db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase());
    const fallback = `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const correct = await verify(password, row ? String(row.password_hash) : fallback);
    if (!row || !row.active || !correct) {
      const count =
        blocked && Number(blocked.until) > Date.now() ? Number(blocked.attempts) + 1 : 1;
      store.db
        .prepare(
          'INSERT INTO login_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts, until=excluded.until',
        )
        .run(key, count, Date.now() + 15 * 60 * 1000);
      throw new TargetError(401, 'Email or password is incorrect.');
    }
    store.db.prepare('DELETE FROM login_limits WHERE key=?').run(key);
    const raw = randomBytes(32).toString('hex'),
      csrf = randomBytes(32).toString('hex');
    store.db
      .prepare('DELETE FROM sessions WHERE expires_at<=? OR token_hash=?')
      .run(Date.now(), digest(token(req)));
    store.db
      .prepare('INSERT INTO sessions VALUES (?,?,?,?)')
      .run(digest(raw), row.id, csrf, Date.now() + 8 * 60 * 60 * 1000);
    res
      .cookie('relay_session', raw, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 })
      .json({ user: userFrom(row), csrfToken: csrf });
  });
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    if (['/mock/records', '/mock/rollback'].includes(req.path) && req.method === 'POST') {
      const supplied = req.get('x-relay-service') || '';
      if (
        supplied.length !== serviceToken.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(serviceToken))
      )
        throw new TargetError(403, 'This endpoint is reserved for the migration service.');
      return next();
    }
    const tokenHash = digest(token(req));
    const row = store.db
      .prepare(
        'SELECT users.*, sessions.csrf, sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=?',
      )
      .get(tokenHash);
    if (!row || !row.active || Number(row.expires_at) <= Date.now())
      throw new TargetError(401, 'Sign in to continue.');
    req.auth = { user: userFrom(row), tokenHash, csrf: String(row.csrf) };
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.get('x-csrf-token') !== req.auth.csrf
    )
      throw new TargetError(403, 'Session verification failed. Refresh and try again.');
    next();
  });
  app.get('/api/auth/me', (req, res) => res.json({ user: actor(req), csrfToken: req.auth!.csrf }));
  app.post('/api/auth/logout', (req, res) => {
    store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.auth!.tokenHash);
    res.clearCookie('relay_session', cookieOptions).json({ ok: true });
  });
  app.post('/api/auth/password', async (req, res) => {
    const body = z
      .object({ currentPassword: z.string().max(200), newPassword: z.string().min(12).max(200) })
      .strict()
      .parse(req.body);
    const row = store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(actor(req).id)!;
    if (!(await verify(body.currentPassword, String(row.password_hash))))
      throw new TargetError(400, 'Current password is incorrect.');
    store.db
      .prepare('UPDATE users SET password_hash=? WHERE id=?')
      .run(await hashPassword(body.newPassword), actor(req).id);
    store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(actor(req).id);
    res.clearCookie('relay_session', cookieOptions).json({ ok: true });
  });
  app.get('/api/users', admin, (_req, res) =>
    res.json(store.db.prepare('SELECT * FROM users ORDER BY role,email').all().map(userFrom)),
  );
}
