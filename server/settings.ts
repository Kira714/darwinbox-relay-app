import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MIN_CONFIDENCE, DEFAULT_MODEL, openRouterClient, type AiClient } from './ai.js';

/**
 * Workspace settings and secrets. Secrets (API keys, webhook URLs, target credentials)
 * are AES-256-GCM encrypted at rest and are write-only over the API: they are never
 * returned to the browser, logged, or included in audit exports.
 */
export interface AiSettings {
  model: string;
  shareSamples: boolean;
  minConfidence: number;
}

function masterKey(dbPath: string | null) {
  if (process.env.RELAY_SECRET_KEY)
    return createHash('sha256').update(process.env.RELAY_SECRET_KEY).digest();
  if (!dbPath) return randomBytes(32);
  const file = join(dirname(dbPath), 'secret.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  const created = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, created.toString('hex'), { mode: 0o600 });
  return created;
}

export class Settings {
  private key: Buffer;
  constructor(
    private db: DatabaseSync,
    dbPath: string | null,
  ) {
    this.key = masterKey(dbPath);
  }

  get(name: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(name);
    return row ? String(row.value) : undefined;
  }
  set(name: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(name, value);
  }
  delete(name: string) {
    this.db.prepare('DELETE FROM settings WHERE key=?').run(name);
  }

  putSecret(name: string, plain: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    this.set(name, [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.'));
  }
  getSecret(name: string): string | undefined {
    const stored = this.get(name);
    if (!stored) return undefined;
    try {
      const [iv, tag, data] = stored.split('.').map((p) => Buffer.from(p, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      return undefined; // key rotated or value corrupted: treat as not configured
    }
  }

  ai(): AiSettings {
    const saved = JSON.parse(this.get('ai') || '{}') as Partial<AiSettings>;
    return {
      model: saved.model || DEFAULT_MODEL,
      shareSamples: !!saved.shareSamples,
      minConfidence: saved.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    };
  }
  saveAi(settings: AiSettings, apiKey?: string) {
    this.set('ai', JSON.stringify(settings));
    if (apiKey) {
      this.putSecret('ai.key', apiKey);
      this.set('ai.hint', `…${apiKey.slice(-4)}`);
    }
  }
  clearAiKey() {
    this.delete('ai.key');
    this.delete('ai.hint');
  }
  apiKey(): { key: string; source: 'saved' | 'env' } | undefined {
    const saved = this.getSecret('ai.key');
    if (saved) return { key: saved, source: 'saved' };
    if (process.env.OPENROUTER_API_KEY)
      return { key: process.env.OPENROUTER_API_KEY, source: 'env' };
    return undefined;
  }
  /** The mapping assistant, or null when no key is configured. */
  aiClient(overrides: Partial<AiSettings> = {}): AiClient | null {
    const credential = this.apiKey();
    return credential ? openRouterClient(credential.key, { ...this.ai(), ...overrides }) : null;
  }
  publicAi() {
    const credential = this.apiKey();
    return {
      provider: 'OpenRouter',
      configured: !!credential,
      source: credential?.source ?? 'none',
      keyHint: credential?.source === 'saved' ? this.get('ai.hint') : undefined,
      ...this.ai(),
    };
  }

  webhook() {
    return this.getSecret('escalation.webhook');
  }
}
