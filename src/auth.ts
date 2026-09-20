import type { User } from '../server/auth';
export type Session = { user: User; csrfToken: string };
let csrf = '';
export function setSession(session: Session | null) {
  csrf = session?.csrfToken || '';
}
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method && !['GET', 'HEAD'].includes(init.method)) headers.set('x-csrf-token', csrf);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/login'))
      window.dispatchEvent(new Event('relay-session-expired'));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body as T;
}
