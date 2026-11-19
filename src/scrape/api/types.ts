import {
  FailureReason,
  PreviewLimits,
  ScrapeMessage,
  ScrapeMode,
} from '../contracts/messages.js';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ScrapeRun {
  id: string;
  siteId: string;
  mode: ScrapeMode;
  specVersion: number;
  schemaVersion: number;
  status: RunStatus;
  reason: FailureReason | null;
  detail: string | null;
  itemCount: number | null;
  pageCount: number | null;
  resultKey: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** A run with the ownership needed to finalize it, for internal use only. */
export interface RunContext extends ScrapeRun {
  customerId: string;
  catalogId: string;
}

export interface ScrapeQueue {
  send(
    message: ScrapeMessage,
    dedupe: { groupId: string; deduplicationId: string },
  ): Promise<void>;
}

export interface ReconcileInput {
  customerId: string;
  catalogId: string;
  siteId: string;
  runId: string;
  schemaVersion: number;
  /** Typed values only; raw text never reaches reconciliation. */
  items: {
    value: Record<string, unknown>;
    variants?: { value: Record<string, unknown> }[];
  }[];
}

/** The reconcile rules themselves arrive in a later change. */
export interface Reconciler {
  reconcile(input: ReconcileInput): Promise<void>;
}

export interface FailedScrapePublisherPort {
  publish(
    event: import('../contracts/messages.js').FailedScrapeEvent,
  ): Promise<void>;
}

export type { PreviewLimits };
