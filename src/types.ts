export type { Run, ReviewCase, RecordRow, Mapping } from '../server/types';
export type { User } from '../server/auth';

export type AiInfo = {
  provider: string;
  configured: boolean;
  source: 'saved' | 'env' | 'none';
  keyHint?: string;
  model: string;
  shareSamples: boolean;
  minConfidence: number;
};
export type SettingsResponse = {
  ai: AiInfo;
  escalationWebhook: { configured: boolean; host?: string };
};
export type SchemaProperty = {
  type: string;
  format?: string;
  enum?: unknown[];
  description?: string;
  title?: string;
};
export type Preset = {
  id: string;
  name: string;
  description: string;
  identityField: string;
  sample: { folder: string; files: string[] };
  schema: { required?: string[]; properties: Record<string, SchemaProperty> } & Record<
    string,
    unknown
  >;
};
export type History = {
  id: string;
  name: string;
  status: string;
  records: number;
  pending: number;
  assignee: string;
  assignedTo?: string;
}[];
