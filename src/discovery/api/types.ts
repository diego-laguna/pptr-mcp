import { PropertyType } from '../../catalog/schema/property-types.js';

export const DISCOVERY_MODES = ['full', 'incremental', 'repair'] as const;
export type DiscoveryMode = (typeof DISCOVERY_MODES)[number];

export type AttemptStatus = 'queued' | 'running' | 'candidate_ready' | 'failed';

export const DISCOVERY_FAILURE_REASONS = [
  'unreachable_site',
  'blocked_by_site',
  'no_catalog_found',
  'verification_failed',
  'invalid_output',
  'cap_exceeded',
  'budget_exhausted',
  'schema_changed',
  'error',
] as const;
export type DiscoveryFailureReason = (typeof DISCOVERY_FAILURE_REASONS)[number];

/** Reasons that repeating the attempt cannot fix. */
export const DETERMINISTIC_DISCOVERY_REASONS = DISCOVERY_FAILURE_REASONS.filter(
  (r) => r !== 'error',
);

export interface SnapshotProperty {
  name: string;
  type: PropertyType;
  description: string;
  example?: unknown;
  values?: string[];
  required: boolean;
}

/** What the attempt may know about the schema; later edits never reach it. */
export interface SchemaSnapshot {
  schemaVersion: number;
  properties: SnapshotProperty[];
  variantProperty: string | null;
}

export interface Usage {
  turns: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface Caps {
  maxTurns: number;
  maxDurationMs: number;
  maxCostUsd: number;
}

export interface DiscoveryAttempt {
  id: string;
  siteId: string;
  mode: DiscoveryMode;
  targetProperties: string[];
  guidance: string | null;
  baseVersion: number | null;
  schemaVersion: number;
  status: AttemptStatus;
  reason: DiscoveryFailureReason | null;
  detail: string | null;
  specVersion: number | null;
  usage: Usage | null;
  evidenceKey: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface AttemptContext extends DiscoveryAttempt {
  customerId: string;
  catalogId: string;
  snapshot: SchemaSnapshot;
}

export interface SpecVersionRecord {
  siteId: string;
  version: number;
  source: 'discovery';
  mode: DiscoveryMode;
  attemptId: string;
  baseVersion: number | null;
  schemaVersion: number;
  boundProperties: string[];
  createdAt: Date;
}

/** Sent to the discovery worker, which has no database access. */
export interface DiscoveryMessage {
  attemptId: string;
  mode: DiscoveryMode;
  customerId: string;
  catalogId: string;
  siteId: string;
  siteUrl: string;
  snapshot: SchemaSnapshot;
  targetProperties: string[];
  guidance: string | null;
  /** Key of the base spec for incremental and repair. */
  baseSpecKey: string | null;
  baseVersion: number | null;
  caps: Caps;
  /** Where the candidate and evidence are written. */
  outputPrefix: string;
}

export interface FinishedAttempt {
  attemptId: string;
  outcome: 'started' | 'candidate' | 'failed';
  reason?: DiscoveryFailureReason;
  detail?: string;
  candidateKey?: string;
  evidenceKey?: string;
  usage?: Usage;
}

export interface DiscoveryQueue {
  send(message: DiscoveryMessage): Promise<void>;
}

export type AdmissionDecision =
  { allowed: true } | { allowed: false; reason?: string };

/** Consulted before an attempt is queued; later budgets replace the allow-all default. */
export interface AdmissionPolicy {
  check(request: {
    customerId: string;
    siteId: string;
    mode: DiscoveryMode;
  }): Promise<AdmissionDecision>;
}

export const allowAllAdmission: AdmissionPolicy = {
  check: async () => ({ allowed: true }),
};
