import type { Configuration } from './configuration.js';

/** A target record: schema field name → string value (typed on delivery). */
export type Row = Record<string, string>;

export interface SourceRow {
  line: number;
  values: Record<string, string>;
}
export interface Source {
  id: string;
  name: string;
  headers: string[];
  rows: SourceRow[];
}
export interface Candidate {
  field: string;
  confidence: number;
}
export type MappingMethod = 'alias' | 'ai' | 'human' | 'pending' | 'ignored';
export interface Mapping {
  id: string;
  sourceId: string;
  column: string;
  target: string | null;
  method: MappingMethod;
  confidence?: number;
  reason: string;
  candidates: Candidate[];
}
export interface Lineage {
  sourceId: string;
  source: string;
  line: number;
  raw: Record<string, string>;
}
export interface RecordRow {
  id: string;
  data: Row;
  lineage: Lineage[];
  state:
    'ready' | 'review' | 'excluded' | 'delivered' | 'failed' | 'rolled_back' | 'rollback_conflict';
  attempts: number;
  error?: string;
}
export interface ReviewCase {
  id: string;
  kind: 'mapping' | 'date' | 'conflict' | 'validation' | 'identity';
  title: string;
  reason: string;
  field?: string;
  sourceId?: string;
  mappingId?: string;
  recordId?: string;
  value: string;
  options: string[];
  context: string;
  validationAttempts?: number;
}
export interface Actor {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'ic';
}
export interface Decision {
  action: 'correct' | 'approve' | 'exclude' | 'ignore' | 'reject';
  reason?: string;
  actor?: Actor;
  value?: string;
  at: string;
}
export interface AuditEvent {
  actor?: Actor;
  id: string;
  at: string;
  kind: 'agent' | 'human' | 'integration' | 'system';
  title: string;
  detail: string;
  recordId?: string;
  before?: unknown;
  after?: unknown;
}
export type RunStatus =
  | 'queued'
  | 'mapping'
  | 'processing'
  | 'review'
  | 'delivering'
  | 'completed'
  | 'partial'
  | 'rolling_back'
  | 'rolled_back'
  | 'rollback_conflict'
  | 'error';

/** How the AI mapper participated in this run. Never claims inference that did not happen. */
export interface AiRunInfo {
  status: 'not_configured' | 'used' | 'failed';
  model?: string;
  servedBy?: string;
  columnsSent: number;
  sharedSamples: boolean;
  error?: string;
}
/** Set while the agent is blocked on a human; explains what went wrong. */
export interface Escalation {
  at: string;
  headline: string;
  items: string[];
  assignee?: string;
  webhook?: 'sent' | 'failed' | 'not_configured';
}

export interface Run {
  id: string;
  name: string;
  configuration: Configuration;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  assignedTo?: string;
  revision?: number;
  status: RunStatus;
  sources: Source[];
  mappings: Mapping[];
  records: RecordRow[];
  cases: ReviewCase[];
  decisions: Record<string, Decision>;
  excludedSources: string[];
  events: AuditEvent[];
  ai?: AiRunInfo;
  escalation?: Escalation;
  error?: string;
}
