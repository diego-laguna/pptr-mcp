import { Injectable } from '@nestjs/common';
import {
  DETERMINISTIC_REASONS,
  FailureReason,
  FinishedMessage,
  parseFinishedMessage,
  RunResult,
  ScrapeMessage,
} from '../contracts/messages.js';
import { ObjectStore } from '../storage/object-store.js';
import { RunsRepository } from './runs.repository.js';
import { FailedScrapePublisherPort, Reconciler, RunContext } from './types.js';

export interface CompletenessConfig {
  /** Allowed relative change in item count versus the previous complete run. */
  maxCountDeviation: number;
  /** Minimum share of present raw values that must parse, per property. */
  minParseRate: number;
}

export const DEFAULT_COMPLETENESS: CompletenessConfig = {
  maxCountDeviation: 0.3,
  minParseRate: 0.8,
};

export interface FinalizerDeps {
  runs: RunsRepository;
  results: ObjectStore;
  reconciler: Reconciler;
  failures: FailedScrapePublisherPort;
  config?: Partial<CompletenessConfig>;
}

/** Per-property share of present raw values that produced a typed value. */
export function parseRates(result: RunResult): Map<string, number> {
  const present = new Map<string, number>();
  const parsed = new Map<string, number>();
  for (const item of result.items) {
    for (const [key, raw] of Object.entries(item.raw)) {
      if (raw === null) continue;
      present.set(key, (present.get(key) ?? 0) + 1);
      if (key in item.value) parsed.set(key, (parsed.get(key) ?? 0) + 1);
    }
  }
  return new Map(
    [...present].map(([key, n]) => [key, (parsed.get(key) ?? 0) / n]),
  );
}

/** Consumes the results queue: decides whether a run is complete and hands it on. */
@Injectable()
export class RunFinalizer {
  private readonly config: CompletenessConfig;

  constructor(private readonly deps: FinalizerDeps) {
    this.config = { ...DEFAULT_COMPLETENESS, ...deps.config };
  }

  async handle(body: unknown): Promise<void> {
    const message = parseFinishedMessage(body);
    const run = await this.deps.runs.getContext(message.runId);
    if (!run) return; // unknown run (for example deleted with its site): nothing to update
    if (run.status === 'succeeded' || run.status === 'failed') return; // redelivery

    if (message.outcome === 'started') {
      await this.deps.runs.markRunning(run.id);
      return;
    }
    if (message.outcome === 'failed') {
      await this.fail(run, message.reason!, message);
      return;
    }
    await this.finishSucceeded(run, message);
  }

  /** A scrape message that exhausted its receives without ever being reported. */
  async handleDeadLetter(message: ScrapeMessage): Promise<void> {
    const run = await this.deps.runs.getContext(message.runId);
    if (!run || run.status === 'succeeded' || run.status === 'failed') return;
    await this.fail(run, 'error', {
      detail:
        'the scrape failed repeatedly and was moved to the dead-letter queue',
    });
  }

  private async finishSucceeded(run: RunContext, message: FinishedMessage) {
    const stats = {
      itemCount: message.stats?.items,
      pageCount: message.stats?.pages,
      resultKey: message.resultKey,
    };
    if (run.mode === 'preview') {
      await this.deps.runs.markSucceeded(run.id, {
        itemCount: stats.itemCount ?? 0,
        pageCount: stats.pageCount ?? 0,
        resultKey: message.resultKey!,
      });
      return;
    }

    const current = await this.deps.runs.currentSchemaVersion(run.siteId);
    if (current !== run.schemaVersion)
      return this.fail(run, 'stale_schema', {
        ...stats,
        detail: `run was pinned to schema version ${run.schemaVersion} but the catalog is at ${current}`,
      });

    const body = await this.deps.results.get(message.resultKey!);
    if (body === null)
      return this.fail(run, 'error', {
        ...stats,
        detail: 'result object is missing',
      });
    const result = JSON.parse(body) as RunResult;

    const previous = await this.deps.runs.previousCompleteItemCount(run.siteId);
    if (previous !== null && previous > 0) {
      const deviation = Math.abs(result.items.length - previous) / previous;
      if (deviation > this.config.maxCountDeviation)
        return this.fail(run, 'count_anomaly', {
          ...stats,
          detail: `${result.items.length} items versus ${previous} in the previous complete run`,
        });
    }

    const weak = [...parseRates(result)].filter(
      ([, rate]) => rate < this.config.minParseRate,
    );
    if (weak.length > 0)
      return this.fail(run, 'parse_anomaly', {
        ...stats,
        detail: weak
          .map(
            ([k, r]) =>
              `${k} parsed for ${Math.round(r * 100)}% of present values`,
          )
          .join('; '),
      });

    await this.deps.reconciler.reconcile({
      customerId: run.customerId,
      catalogId: run.catalogId,
      siteId: run.siteId,
      runId: run.id,
      schemaVersion: run.schemaVersion,
      items: result.items.map((item) => ({
        value: item.value,
        variants: item.variants?.map((v) => ({ value: { ...v.value } })),
      })),
    });
    await this.deps.runs.markSucceeded(run.id, {
      itemCount: result.items.length,
      pageCount: result.pages,
      resultKey: message.resultKey!,
    });
  }

  private async fail(
    run: RunContext,
    reason: FailureReason,
    info: {
      detail?: string;
      itemCount?: number;
      pageCount?: number;
      resultKey?: string;
      stats?: { items: number; pages: number };
    },
  ) {
    await this.deps.runs.markFailed(run.id, {
      reason,
      detail: info.detail,
      itemCount: info.itemCount ?? info.stats?.items,
      pageCount: info.pageCount ?? info.stats?.pages,
      resultKey: info.resultKey,
    });
    if (run.mode === 'production') {
      await this.deps.failures.publish({
        runId: run.id,
        siteId: run.siteId,
        catalogId: run.catalogId,
        customerId: run.customerId,
        reason,
        detail: info.detail,
      });
    }
  }
}

export const isDeterministic = (reason: FailureReason) =>
  DETERMINISTIC_REASONS.includes(reason);
