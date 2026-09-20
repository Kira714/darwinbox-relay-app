import { useEffect, useState } from 'react';
import { Check, CircleAlert, KeyRound, Loader2, Send, Sparkles, Trash2 } from 'lucide-react';
import { request } from '../auth';
import type { SettingsResponse } from '../types';
import { Badge } from '../ui';

type Model = { id: string; name: string; context: number; structured: boolean };
const json = { 'Content-Type': 'application/json' };

/** Admin-only: the AI key is entered once, stored encrypted on the server, and never shown again. */
export function SettingsPanel({
  settings,
  onChange,
}: {
  settings: SettingsResponse;
  onChange: (s: SettingsResponse) => void;
}) {
  const { ai } = settings;
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(ai.model);
  const [percent, setPercent] = useState(Math.round(ai.minConfidence * 100));
  const [share, setShare] = useState(ai.shareSamples);
  const [models, setModels] = useState<Model[]>([]);
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'remove'>('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [webhook, setWebhook] = useState('');
  const [hookMsg, setHookMsg] = useState('');

  useEffect(() => {
    void request<{ models: Model[] }>('/api/settings/ai/models')
      .then((r) => setModels(r.models))
      .catch(() => undefined);
  }, []);

  const refresh = () => request<SettingsResponse>('/api/settings').then(onChange);

  async function test() {
    setBusy('test');
    setResult(null);
    try {
      const r = await request<{ servedBy: string; ms: number }>('/api/settings/ai/test', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
      });
      setResult({
        ok: true,
        text: `Connected. Answered by ${r.servedBy} in ${(r.ms / 1000).toFixed(1)}s.`,
      });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy('');
    }
  }
  async function save() {
    setBusy('save');
    setResult(null);
    try {
      await request('/api/settings/ai', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({
          model,
          shareSamples: share,
          minConfidence: percent / 100,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      setApiKey('');
      await refresh();
      setResult({
        ok: true,
        text: 'Saved. The key is stored encrypted and will not be shown again.',
      });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy('');
    }
  }
  async function remove() {
    setBusy('remove');
    try {
      await request('/api/settings/ai/key', { method: 'DELETE' });
      await refresh();
      setResult({ ok: true, text: 'Key removed. The agent will use known aliases only.' });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy('');
    }
  }
  async function saveWebhook(clear = false) {
    setHookMsg('');
    try {
      await request('/api/settings/escalation', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ webhookUrl: clear ? '' : webhook.trim() }),
      });
      setWebhook('');
      await refresh();
      setHookMsg(clear ? 'Webhook removed.' : 'Webhook saved.');
    } catch (e) {
      setHookMsg((e as Error).message);
    }
  }

  return (
    <div className="settings">
      <section>
        <div className="settings-title">
          <Sparkles size={17} />
          <h3>AI column mapping</h3>
          <Badge tone={ai.configured ? 'green' : 'amber'}>
            {ai.configured
              ? `Key ${ai.source === 'env' ? 'from environment' : ai.keyHint || 'saved'}`
              : 'Not configured'}
          </Badge>
        </div>
        <p className="muted">
          Uses <strong>OpenRouter</strong>, which serves free open-weight models. The model only
          proposes; the agent still validates every value, never lets two columns collide, and asks
          a person when it is unsure.
        </p>
        <label htmlFor="ai-key">OpenRouter API key</label>
        <div className="input-with-icon">
          <KeyRound size={15} />
          <input
            id="ai-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              ai.source === 'saved'
                ? `Saved (${ai.keyHint}) — leave blank to keep it`
                : 'sk-or-v1-…'
            }
          />
        </div>
        <label htmlFor="ai-model">Model</label>
        <input
          id="ai-model"
          list="free-models"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          spellCheck={false}
        />
        <datalist id="free-models">
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.structured ? ' · JSON mode' : ''}
            </option>
          ))}
        </datalist>
        <p className="field-hint">
          {models.length
            ? `${models.length} free models available right now — type to search, or paste any OpenRouter model id.`
            : 'Any OpenRouter model id works. If it is busy the agent retries, then falls back to openrouter/free.'}
        </p>
        <label htmlFor="ai-threshold">
          Ask a person when confidence is below <strong>{percent}%</strong>
        </label>
        <input
          id="ai-threshold"
          type="range"
          min={50}
          max={99}
          step={5}
          value={percent}
          onChange={(e) => setPercent(Number(e.target.value))}
        />
        <p className="field-hint">
          Higher = more questions, fewer mistakes. Model confidence is self-reported, so treat it as
          a dial, not a probability.
        </p>
        <label className="check">
          <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
          <span>
            Also send a few sample values with each column
            <small>
              Off by default: only column names and value <em>shapes</em> (like “AA-999”) leave your
              machine, never employee data.
            </small>
          </span>
        </label>
        <div className="settings-actions">
          <button
            className="button"
            disabled={!!busy || (!apiKey.trim() && !ai.configured)}
            onClick={() => void test()}
          >
            {busy === 'test' ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Test
            connection
          </button>
          <button
            className="button primary"
            disabled={!!busy || (!apiKey.trim() && !ai.configured)}
            onClick={() => void save()}
          >
            {busy === 'save' && <Loader2 size={14} className="spin" />} Save
          </button>
          {ai.source === 'saved' && (
            <button className="text-button danger" disabled={!!busy} onClick={() => void remove()}>
              <Trash2 size={13} /> Remove key
            </button>
          )}
        </div>
        {result && (
          <div className={result.ok ? 'inline-ok' : 'inline-error'} role="status">
            {result.ok ? <Check size={15} /> : <CircleAlert size={15} />}
            {result.text}
          </div>
        )}
      </section>

      <section>
        <div className="settings-title">
          <Send size={17} />
          <h3>Escalation webhook</h3>
          <Badge tone={settings.escalationWebhook.configured ? 'green' : 'neutral'}>
            {settings.escalationWebhook.configured ? settings.escalationWebhook.host : 'Off'}
          </Badge>
        </div>
        <p className="muted">
          When the agent needs a person, also post a message to a Slack-compatible incoming webhook
          so nobody has to watch the screen. Optional.
        </p>
        <input
          aria-label="Escalation webhook URL"
          type="password"
          autoComplete="off"
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
          placeholder="https://hooks.slack.com/services/…"
        />
        <div className="settings-actions">
          <button className="button" disabled={!webhook.trim()} onClick={() => void saveWebhook()}>
            Save webhook
          </button>
          {settings.escalationWebhook.configured && (
            <button className="text-button danger" onClick={() => void saveWebhook(true)}>
              <Trash2 size={13} /> Remove
            </button>
          )}
        </div>
        {hookMsg && (
          <p className="field-hint" role="status">
            {hookMsg}
          </p>
        )}
      </section>
    </div>
  );
}
