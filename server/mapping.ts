import {
  fieldNames,
  isRequired,
  key,
  normalizeValue,
  specOf,
  validateValue,
} from './configuration.js';
import type { AiClient, Suggestion } from './ai.js';
import { audit } from './engine.js';
import { profileColumn } from './profile.js';
import type { Candidate, Mapping, Run, Source } from './types.js';

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** A typed target only accepts a column whose populated values could actually satisfy it. */
function valuesFit(run: Run, field: string, values: string[]) {
  const spec = specOf(run.configuration, field);
  const typed = spec.format || spec.enum || spec.pattern || spec.type !== 'string';
  if (!typed) return true;
  return values
    .filter((v) => v.trim())
    .slice(0, 25)
    .every((v) => {
      const n = normalizeValue(run.configuration, field, v);
      return !!n.options || !validateValue(run.configuration, field, n.value);
    });
}

/**
 * Decides every source column's target.
 *   1. Confirmed aliases from the schema are applied without asking anyone.
 *   2. Remaining columns go to the AI (if configured) as headers + local value profiles.
 *   3. Its proposals are accepted only when confident, unambiguous, type-compatible and
 *      collision-free; everything else becomes a review case with the AI's reasoning.
 * With no AI (or on AI failure) unknown columns simply escalate: the agent never guesses.
 */
export async function mapSources(run: Run, ai: AiClient | null) {
  const cfg = run.configuration;
  const fields = fieldNames(cfg);
  run.ai = {
    status: ai ? 'used' : 'not_configured',
    model: ai?.model,
    columnsSent: 0,
    sharedSamples: !!ai?.shareSamples,
  };

  const aliases = new Map<string, Set<string>>();
  for (const field of fields) {
    const spec = specOf(cfg, field);
    for (const name of [field, spec.title, ...(spec['x-aliases'] || [])])
      if (name) aliases.set(key(name), (aliases.get(key(name)) || new Set()).add(field));
  }
  const taken = (source: Source, target: string) =>
    run.mappings.some((m) => m.sourceId === source.id && m.target === target);
  const record = (
    source: Source,
    column: string,
    mapping: Omit<Mapping, 'id' | 'sourceId' | 'column'>,
  ) => {
    const id = `${source.id}:${column}`;
    run.mappings.push({ id, sourceId: source.id, column, ...mapping });
    const outcome = mapping.target
      ? `→ ${mapping.target}`
      : mapping.method === 'ignored'
        ? 'ignored (no target field)'
        : 'is awaiting review';
    audit(
      run,
      mapping.method === 'pending' ? 'Mapping needs context' : 'Column mapped',
      `${source.name}: “${column}” ${outcome}. ${mapping.reason}`,
      {
        id: `map:${run.id}:${id}`,
        after: { target: mapping.target, method: mapping.method, confidence: mapping.confidence },
      },
    );
  };

  for (const source of run.sources) {
    const unresolved: string[] = [];
    for (const column of source.headers) {
      if (run.mappings.some((m) => m.id === `${source.id}:${column}`)) continue;
      const hits = [...(aliases.get(key(column)) || [])];
      if (hits.length === 1 && !taken(source, hits[0]))
        record(source, column, {
          target: hits[0],
          method: 'alias',
          confidence: 1,
          candidates: [],
          reason: 'Recognized alias declared in the target schema.',
        });
      else unresolved.push(column);
    }
    if (!unresolved.length) continue;

    let suggestions = new Map<string, Suggestion>();
    let failure = ai
      ? ''
      : 'AI mapping is not configured, so this column needs a person to place it.';
    if (ai) {
      try {
        const result = await ai.map({
          config: cfg,
          sourceName: source.name,
          columns: unresolved.map((column) => ({
            column,
            profile: profileColumn(
              source.rows.map((r) => r.values[column] ?? ''),
              ai.shareSamples,
            ),
          })),
        });
        run.ai.columnsSent += unresolved.length;
        run.ai.servedBy = result.servedBy;
        suggestions = new Map(result.suggestions.map((s) => [s.column, s]));
        audit(
          run,
          'AI mapping consulted',
          `${source.name}: ${unresolved.length} unfamiliar column(s) sent to ${result.servedBy} as headers${ai.shareSamples ? ', value profiles and sample values' : ' and value shapes only (no raw values)'}.`,
          { id: `ai:${run.id}:${source.id}` },
        );
      } catch (e) {
        run.ai.status = 'failed';
        run.ai.error = (e as Error).message;
        failure = `AI mapping failed (${(e as Error).message}). The agent will not guess; a person must place this column.`;
        audit(
          run,
          'AI mapping unavailable',
          `${source.name}: ${(e as Error).message}. Falling back to rules; unfamiliar columns are escalated.`,
          { id: `ai-fail:${run.id}:${source.id}` },
        );
      }
    }

    const ranked = unresolved
      .map((column) => ({ column, s: suggestions.get(column) }))
      .sort((a, b) => (b.s?.confidence ?? 0) - (a.s?.confidence ?? 0));
    for (const { column, s } of ranked) {
      const values = source.rows.map((r) => r.values[column] ?? '');
      const candidates: Candidate[] = s
        ? [...(s.target ? [s.target] : []), ...s.alternatives]
            .filter((f, i, all) => fields.includes(f) && all.indexOf(f) === i)
            .map((field, i) => ({ field, confidence: i === 0 && s.target ? s.confidence : 0 }))
        : [];
      const pending = (reason: string) =>
        record(source, column, {
          target: null,
          method: 'pending',
          confidence: s?.confidence,
          candidates,
          reason,
        });
      if (!s) {
        pending(failure || 'The AI returned no answer for this column.');
        continue;
      }
      const sure = s.confidence >= ai!.minConfidence;
      if (s.target === null) {
        if (sure)
          record(source, column, {
            target: null,
            method: 'ignored',
            confidence: s.confidence,
            candidates,
            reason: `AI is ${pct(s.confidence)} sure this column has no counterpart in the target schema (${s.reason}). Ignored automatically; visible here and in the audit trail.`,
          });
        else
          pending(
            `AI found no matching field but is only ${pct(s.confidence)} sure (${s.reason}). Confirm whether to ignore it.`,
          );
      } else if (!fields.includes(s.target))
        pending(`AI proposed “${s.target}”, which is not a field of this schema.`);
      else if (!sure)
        pending(
          `AI suggests “${s.target}” but is only ${pct(s.confidence)} sure (needs ${pct(ai!.minConfidence)}): ${s.reason}`,
        );
      else if (taken(source, s.target))
        pending(
          `AI suggests “${s.target}”, but another column in this file already maps there. Choose one or ignore the other.`,
        );
      else if (!valuesFit(run, s.target, values))
        pending(
          `AI suggests “${s.target}”, but this column's values do not fit that field's format.`,
        );
      else
        record(source, column, {
          target: s.target,
          method: 'ai',
          confidence: s.confidence,
          candidates,
          reason: `AI (${run.ai.servedBy}) mapped this with ${pct(s.confidence)} confidence: ${s.reason} Value shapes fit the target field.`,
        });
    }
  }

  // A required field nobody maps is worse than an ignored column: give auto-ignored
  // columns that the AI considered for it back to a human.
  for (const field of fields.filter(
    (f) => isRequired(cfg, f) && !run.mappings.some((m) => m.target === f),
  ))
    for (const m of run.mappings.filter(
      (m) => m.method === 'ignored' && m.candidates.some((c) => c.field === field),
    )) {
      m.method = 'pending';
      m.reason = `Required field “${field}” has no source column yet, and the AI considered this column. Confirm the mapping or ignore it.`;
    }
}
