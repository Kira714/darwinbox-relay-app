import { audit, describeEscalation } from './engine.js';
import type { Settings } from './settings.js';
import type { Store } from './store.js';
import type { Escalation, Run } from './types.js';

/**
 * Hands a blocked run to a person: records what went wrong on the run (shown at the top
 * of the migration), writes an audit event, and pings the optional webhook
 * (Slack-compatible "incoming webhook" JSON) so nobody has to be watching the screen.
 */
export async function escalate(
  run: Run,
  ctx: { store: Store; settings: Settings },
  reason: 'review' | 'delivery' | 'error',
) {
  const assignee = run.assignedTo
    ? String(
        ctx.store.db.prepare('SELECT name FROM users WHERE id=?').get(run.assignedTo)?.name ?? '',
      )
    : '';
  let escalation: Escalation | undefined;
  if (reason === 'review') escalation = describeEscalation(run);
  else if (reason === 'delivery') {
    const outstanding = run.records.filter((r) => ['failed', 'ready'].includes(r.state));
    const errors = new Map<string, number>();
    for (const r of outstanding) if (r.error) errors.set(r.error, (errors.get(r.error) || 0) + 1);
    escalation = {
      at: new Date().toISOString(),
      headline: `${outstanding.length} of ${run.records.filter((r) => r.state !== 'excluded').length} records could not be delivered`,
      items: [...errors].slice(0, 3).map(([message, n]) => `${n}× ${message}`),
    };
  } else
    escalation = {
      at: new Date().toISOString(),
      headline: 'The agent stopped unexpectedly',
      items: [run.error || 'Unknown error'],
    };
  if (!escalation) return;
  if (reason === 'review') {
    if (run.ai?.status === 'failed')
      escalation.items.unshift(`AI mapping was unavailable (${run.ai.error})`);
    else if (run.ai?.status === 'not_configured' && run.cases.some((c) => c.kind === 'mapping'))
      escalation.items.unshift(
        'AI mapping is not configured: add an OpenRouter key in Settings so the agent can place unfamiliar columns itself',
      );
  }
  escalation.assignee = assignee || undefined;
  escalation.at = new Date().toISOString();

  const url = ctx.settings.webhook();
  escalation.webhook = 'not_configured';
  if (url) {
    const text = [
      `*Relay needs a person: ${run.name}*`,
      escalation.headline,
      ...escalation.items.map((i) => `• ${i}`),
    ].join('\n');
    try {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          relay: { runId: run.id, status: run.status, assignee: assignee || null },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      escalation.webhook = res.ok ? 'sent' : 'failed';
    } catch {
      escalation.webhook = 'failed';
    }
  }
  run.escalation = escalation;
  audit(
    run,
    assignee ? `Escalated to ${assignee}` : 'Escalated for review',
    `${escalation.headline}. ${escalation.items.join('; ')}.${
      escalation.webhook === 'sent'
        ? ' Notification sent to the escalation webhook.'
        : escalation.webhook === 'failed'
          ? ' The escalation webhook could not be reached.'
          : ''
    }`,
    { kind: 'system' },
  );
  ctx.store.save(run);
}
