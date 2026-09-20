import { randomUUID } from 'node:crypto';
import { fieldNames, identityFields, normalizeValue, validateValue } from './configuration.js';
import type { AuditEvent, Decision, Escalation, RecordRow, ReviewCase, Row, Run } from './types.js';

/** Append an audit event. Events with a caller-supplied id are recorded once. */
export function audit(run: Run, title: string, detail: string, extra: Partial<AuditEvent> = {}) {
  const id = extra.id || randomUUID();
  if (run.events.some((e) => e.id === id)) return;
  run.events.push({ id, at: new Date().toISOString(), kind: 'agent', title, detail, ...extra });
}

const rowKey = (sourceId: string, line: number) => `${sourceId}:${line}`;
const label = (field: string) => field.replace(/_/g, ' ');

function decisionValue(run: Run, id: string, fallback: string) {
  const d = run.decisions[id];
  return d && ['correct', 'approve'].includes(d.action) ? (d.value ?? fallback) : fallback;
}

/**
 * Rebuilds records and the review queue from mappings + decisions. Pure with respect
 * to inputs, so it can be re-run after every human decision.
 */
export function reconcile(run: Run) {
  const cfg = run.configuration;
  const fields = fieldNames(cfg);
  const identity = cfg.identityField;
  run.cases = [];
  for (const m of run.mappings.filter((m) => m.method === 'pending')) {
    const source = run.sources.find((s) => s.id === m.sourceId)!;
    run.cases.push({
      id: `mapping:${m.id}`,
      kind: 'mapping',
      mappingId: m.id,
      sourceId: m.sourceId,
      title: `Where does “${m.column}” belong?`,
      reason: m.reason,
      value: m.column,
      options: m.candidates.slice(0, 3).map((c) => c.field),
      context: `${source.name} · samples: ${source.rows
        .slice(0, 3)
        .map((r) => r.values[m.column] || '(blank)')
        .join(' · ')}`,
    });
  }
  if (run.cases.length) {
    run.status = 'review';
    run.escalation = describeEscalation(run);
    return;
  }

  const groups = new Map<
    string,
    { record: RecordRow; issues: ReviewCase[]; values: Map<string, Set<string>> }
  >();
  for (const source of run.sources)
    for (const raw of source.rows) {
      const sourceKey = rowKey(source.id, raw.line);
      const excluded = run.excludedSources.includes(sourceKey);
      const data: Row = {};
      const issues: ReviewCase[] = [];
      for (const mapping of run.mappings.filter((m) => m.sourceId === source.id && m.target)) {
        const field = mapping.target!;
        const original = raw.values[mapping.column];
        const id = `cell:${sourceKey}:${field}`;
        const result = normalizeValue(cfg, field, original);
        // An ambiguous cell contributes no value until a person decides, so it can never
        // masquerade as a competing value against another source's unambiguous one.
        const undecided = !!result.issue && !run.decisions[id];
        const value = undecided ? '' : decisionValue(run, id, result.value);
        if (value) data[field] = value;
        if (value !== original && !undecided)
          audit(
            run,
            'Value normalized',
            `${source.name}, row ${raw.line} · ${field}. Safe normalization or reviewed correction applied.`,
            { id: `normalize:${run.id}:${id}:${value}`, before: original, after: value },
          );
        if (result.issue && !run.decisions[id] && !excluded)
          issues.push({
            id,
            kind: 'date',
            field,
            title: 'A date with two meanings',
            reason: result.issue,
            value: original,
            options: result.options || [],
            context: `${source.name} · row ${raw.line} · ${data.full_name || data[identity] || 'record'}`,
          });
      }
      const groupKey = excluded
        ? `excluded:${data[identity] || sourceKey}`
        : data[identity]
          ? `id:${data[identity]}`
          : `row:${sourceKey}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          record: {
            id: sourceKey,
            data: {},
            lineage: [],
            state: excluded ? 'excluded' : 'ready',
            attempts: 0,
          },
          issues: [],
          values: new Map(),
        };
        groups.set(groupKey, group);
      }
      group.record.lineage.push({
        sourceId: source.id,
        source: source.name,
        line: raw.line,
        raw: raw.values,
      });
      for (const issue of issues) {
        issue.recordId = group.record.id;
        group.issues.push(issue);
      }
      for (const field of fields)
        if (data[field]) {
          if (!group.values.has(field)) group.values.set(field, new Set());
          group.values.get(field)!.add(data[field]);
        }
    }

  run.records = [];
  for (const { record: row, issues, values } of groups.values()) {
    const who = () => row.data.full_name || row.data[identity] || 'Record';
    const where = () => `${row.lineage[0].source}, row ${row.lineage[0].line}`;
    for (const field of fields) {
      const options = [...(values.get(field) || [])];
      const conflictId = `conflict:${row.id}:${field}`;
      const value = decisionValue(run, conflictId, options[0] || '');
      if (value) row.data[field] = value;
      if (options.length > 1 && !run.decisions[conflictId] && row.state !== 'excluded')
        issues.push({
          id: conflictId,
          kind: 'conflict',
          recordId: row.id,
          field,
          title: `Sources disagree on ${label(field)}`,
          reason:
            'The same record appears in multiple exports with different values. No source has established precedence.',
          value: options.join(' ↔ '),
          options,
          context: `${who()} · ${row.lineage.map((l) => `${l.source}, row ${l.line}`).join(' / ')}`,
        });
      const corrected = decisionValue(run, `validation:${row.id}:${field}`, row.data[field] || '');
      if (corrected) row.data[field] = corrected;
      else delete row.data[field];
      const identityCorrected = decisionValue(
        run,
        `identity:${row.id}:${field}`,
        row.data[field] || '',
      );
      if (identityCorrected) row.data[field] = identityCorrected;
    }
    if (row.state !== 'excluded') {
      for (const field of fields) {
        const error = validateValue(cfg, field, row.data[field] || '');
        if (!error || issues.some((i) => i.field === field)) continue;
        const id = `validation:${row.id}:${field}`;
        // One bounded repair and a second validation. Never invent a required value
        // or keep retrying an impossible repair.
        const repaired = normalizeValue(cfg, field, row.data[field] || '');
        const secondError = validateValue(cfg, field, repaired.value);
        if (!secondError && !repaired.issue) {
          const before = row.data[field];
          if (repaired.value) row.data[field] = repaired.value;
          else delete row.data[field];
          audit(
            run,
            'Validation repair applied',
            `${field}: bounded normalization passed revalidation.`,
            {
              id: `repair:${run.id}:${id}`,
              recordId: row.id,
              before,
              after: repaired.value,
            },
          );
          continue;
        }
        issues.push({
          id,
          kind: 'validation',
          recordId: row.id,
          field,
          title: row.data[field] ? `Check ${label(field)}` : `Missing ${label(field)}`,
          reason: `Validation before and after safe cleanup did not produce a valid value. ${secondError || error}. The agent will not invent data.`,
          value: row.data[field] || '',
          options: [],
          validationAttempts: 2,
          context: `${who()} · ${where()}`,
        });
      }
      run.cases.push(...issues);
    }
    if (row.lineage.length > 1)
      audit(
        run,
        'Records reconciled',
        `${who()}: ${row.lineage.length} source rows share ${label(identity)} ${row.data[identity] ?? ''}. All lineage retained; conflicting fields require review.`,
        {
          id: `merge:${run.id}:${row.id}`,
          recordId: row.id,
          after: row.lineage.map((l) => ({ source: l.source, line: l.line })),
        },
      );
    run.records.push(row);
  }

  // Identity/unique fields are checked on the final (possibly corrected) values.
  for (const field of identityFields(cfg)) {
    const seen = new Map<string, RecordRow>();
    for (const row of run.records.filter((r) => r.state !== 'excluded')) {
      const value = row.data[field];
      if (!value) continue;
      const other = seen.get(value);
      if (!other) {
        seen.set(value, row);
        continue;
      }
      run.cases.push({
        id: `identity:${row.id}:${field}`,
        kind: 'identity',
        recordId: row.id,
        field,
        title: `Two records share ${label(field)}`,
        reason: `This value is also used by ${other.data.full_name || other.data[identity]}. Correct it using client evidence or exclude this record. Names alone cannot prove identity.`,
        value,
        options: [],
        context: `${row.data.full_name || row.data[identity]} · conflicts with ${other.data[identity]}`,
      });
    }
  }
  for (const row of run.records)
    if (row.state !== 'excluded')
      row.state = run.cases.some((c) => c.recordId === row.id) ? 'review' : 'ready';
  run.status = run.cases.length ? 'review' : 'processing';
  run.escalation = describeEscalation(run);
}

/** Plain-language explanation of what is blocking the run, shown to the consultant. */
export function describeEscalation(run: Run): Escalation | undefined {
  if (!run.cases.length) return undefined;
  const count = (kind: ReviewCase['kind']) => run.cases.filter((c) => c.kind === kind).length;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const items = [
    count('mapping') &&
      `${plural(count('mapping'), 'column')} the agent could not place with enough confidence`,
    count('date') && `${plural(count('date'), 'ambiguous date')} (day/month order unclear)`,
    count('conflict') && `${plural(count('conflict'), 'conflicting value')} between source files`,
    count('validation') &&
      `${plural(count('validation'), 'invalid or missing value')} that cannot be cleaned safely`,
    count('identity') &&
      `${plural(count('identity'), 'identity collision')} between different records`,
  ].filter(Boolean) as string[];
  return {
    at: run.escalation?.at || new Date().toISOString(),
    headline: `${plural(run.cases.length, 'decision')} needed before anything is sent to the target`,
    items,
    assignee: run.escalation?.assignee,
    webhook: run.escalation?.webhook,
  };
}

export function resolveCase(run: Run, caseId: string, decision: Decision) {
  const cfg = run.configuration;
  const fields = fieldNames(cfg);
  if (run.status !== 'review') throw new Error('This migration is not awaiting review.');
  const item = run.cases.find((c) => c.id === caseId);
  if (!item) throw new Error('This case is no longer pending. Refresh the review queue.');
  const rejecting = ['exclude', 'reject'].includes(decision.action);
  if (item.kind === 'mapping') {
    if (!['ignore', 'approve', 'correct'].includes(decision.action))
      throw new Error('Select a target field or ignore this column.');
    const m = run.mappings.find((m) => m.id === item.mappingId)!;
    if (decision.action === 'ignore') {
      m.method = 'ignored';
      m.target = null;
    } else {
      if (!decision.value || !fields.includes(decision.value))
        throw new Error('Select a supported target field.');
      if (
        run.mappings.some(
          (o) => o.id !== m.id && o.sourceId === m.sourceId && o.target === decision.value,
        )
      )
        throw new Error(
          'This target already has a source column. Ignore the competing column to avoid overwriting values.',
        );
      m.target = decision.value;
      m.method = 'human';
    }
    m.reason = 'Explicit mapping decision by the consultant.';
  } else if (rejecting) {
    const row = run.records.find((r) => r.id === item.recordId)!;
    run.excludedSources.push(...row.lineage.map((l) => rowKey(l.sourceId, l.line)));
  } else {
    if (!['approve', 'correct'].includes(decision.action))
      throw new Error('Correct the value or reject the record.');
    if (decision.value === undefined || !item.field)
      throw new Error('A corrected value is required.');
    if (decision.action === 'approve' && !item.options.includes(decision.value))
      throw new Error('Approve one of the proposed values or submit a correction.');
    const normalized = normalizeValue(cfg, item.field, decision.value);
    if (normalized.issue) throw new Error('Choose an unambiguous value, such as YYYY-MM-DD.');
    const error = validateValue(cfg, item.field, normalized.value);
    if (error) throw new Error(error);
    if (
      identityFields(cfg).includes(item.field) &&
      run.records.some(
        (r) =>
          r.id !== item.recordId &&
          r.state !== 'excluded' &&
          r.data[item.field!] === normalized.value,
      )
    )
      throw new Error(
        'Another record already uses that value. Provide a unique value or reject the record.',
      );
    decision.value = normalized.value;
  }
  run.decisions[caseId] = decision;
  audit(
    run,
    rejecting ? 'Record rejected by consultant' : 'Review decision applied',
    `${item.title}. ${
      rejecting
        ? 'All source rows for this record were excluded.'
        : decision.action === 'ignore'
          ? 'Column explicitly ignored.'
          : `Consultant selected “${decision.value || '(omit optional value)'}”.`
    }`,
    {
      kind: 'human',
      actor: decision.actor,
      recordId: item.recordId,
      before: item.value,
      after: decision,
      id: `decision:${run.id}:${caseId}:${randomUUID()}`,
    },
  );
  reconcile(run);
}
