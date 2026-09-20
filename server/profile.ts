/**
 * Local, privacy-preserving description of a source column. By default only these
 * statistics and character *shapes* (e.g. "AA-999") reach the AI provider, never raw values.
 */
export interface ColumnProfile {
  filled: number;
  total: number;
  distinct: number;
  kind: 'empty' | 'email' | 'date' | 'integer' | 'number' | 'boolean' | 'text';
  shapes: { shape: string; count: number }[];
  /** Only present when the operator opted in to share sample values. */
  samples?: string[];
}

export function shapeOf(value: string) {
  return value
    .trim()
    .replace(/[A-Z]/g, 'A')
    .replace(/[a-z]/g, 'a')
    .replace(/\d/g, '9')
    .replace(/(.)\1{3,}/g, '$1+')
    .slice(0, 40);
}

function kindOf(values: string[]): ColumnProfile['kind'] {
  if (!values.length) return 'empty';
  const all = (test: (v: string) => boolean) => values.every(test);
  if (all((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return 'email';
  if (all((v) => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(v))) return 'date';
  if (all((v) => /^-?\d+$/.test(v))) return 'integer';
  if (all((v) => /^-?\d+([.,]\d+)?$/.test(v))) return 'number';
  if (all((v) => ['true', 'false', 'yes', 'no', 'y', 'n'].includes(v.toLowerCase())))
    return 'boolean';
  return 'text';
}

export function profileColumn(all: string[], shareSamples = false): ColumnProfile {
  const values = all.map((v) => v.trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const v of values) counts.set(shapeOf(v), (counts.get(shapeOf(v)) || 0) + 1);
  const distinct = new Set(values.map((v) => v.toLowerCase()));
  const profile: ColumnProfile = {
    filled: values.length,
    total: all.length,
    distinct: distinct.size,
    kind: kindOf(values),
    shapes: [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([shape, count]) => ({ shape, count })),
  };
  if (shareSamples) {
    // Low-cardinality columns (statuses, departments) are described by their categories.
    const pool = distinct.size <= 8 ? [...new Set(values)] : values;
    profile.samples = [...new Set(pool)].slice(0, 8);
  }
  return profile;
}
