import {
  FinishedMessage,
  RunResult,
  ScrapeMessage,
} from '../contracts/messages.js';
import { buildItems } from '../runner/extract.js';
import { schemaMismatches } from '../runner/schema-check.js';
import { RawRun, RunOptions } from '../runner/runner.js';
import { SelectorSpec } from '../spec/selector-spec.js';
import { InvalidSpecError } from '../spec/spec-validator.js';
import { SpecNotFoundError, SpecStore } from '../spec/spec-store.js';
import { ObjectStore } from '../storage/object-store.js';
import { resultKey } from '../storage/keys.js';

export interface FinishedPublisher {
  send(message: FinishedMessage): Promise<void>;
}

export interface WorkerDeps {
  specs: SpecStore;
  results: ObjectStore;
  publisher: FinishedPublisher;
  /** Opens a browser and runs the spec; replaced by a fake in unit tests. */
  execute(spec: SelectorSpec, options: RunOptions): Promise<RawRun>;
  safetyMarginMs?: number;
  now?: () => number;
}

/** Run time left, in ms, for this invocation (Lambda context or a fixed budget). */
export interface WorkerContext {
  remainingMs(): number;
}

/**
 * Stateless: reads the spec and the message, writes the result to object
 * storage and a finished message to the results queue. It has no database
 * access. Unexpected errors (browser crash, network) are thrown so the queue
 * redelivers the message; known failures are reported and acknowledged.
 */
export class ScrapeWorker {
  constructor(private readonly deps: WorkerDeps) {}

  async handle(
    message: ScrapeMessage,
    context: WorkerContext,
  ): Promise<FinishedMessage> {
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    const fail = (
      reason: 'no_spec' | 'invalid_spec' | 'schema_mismatch',
      detail: string,
    ) =>
      this.report({ runId: message.runId, outcome: 'failed', reason, detail });

    await this.report({ runId: message.runId, outcome: 'started' });

    let spec: SelectorSpec;
    try {
      spec = await this.deps.specs.load(message.specKey);
    } catch (error) {
      if (error instanceof SpecNotFoundError)
        return fail('no_spec', error.message);
      if (error instanceof InvalidSpecError)
        return fail('invalid_spec', error.message);
      throw error;
    }

    const mismatches = schemaMismatches(spec, message.schema);
    if (mismatches.length > 0)
      return fail('schema_mismatch', mismatches.join('; '));

    const raw = await this.deps.execute(spec, {
      deadline: startedAt + context.remainingMs(),
      safetyMarginMs: this.deps.safetyMarginMs ?? 20_000,
      limits: message.limits,
      now,
    });

    const { items, skipped } = buildItems(raw.rawItems, spec);
    const result: RunResult = {
      runId: message.runId,
      siteId: message.siteId,
      specVersion: message.specVersion,
      schemaVersion: message.schemaVersion,
      mode: message.mode,
      finished: raw.finished,
      pages: raw.pages,
      skipped,
      items,
    };
    // Results always travel by reference: they can exceed the queue's message size.
    const key = resultKey(
      message.customerId,
      message.catalogId,
      message.siteId,
      message.runId,
    );
    await this.deps.results.put(key, JSON.stringify(result));

    const stats = {
      items: items.length,
      pages: raw.pages,
      durationMs: now() - startedAt,
    };
    return this.report(
      raw.finished
        ? { runId: message.runId, outcome: 'succeeded', resultKey: key, stats }
        : {
            runId: message.runId,
            outcome: 'failed',
            reason: 'timeout',
            resultKey: key,
            stats,
            detail: 'the run reached its time limit before finishing',
          },
    );
  }

  private async report(message: FinishedMessage): Promise<FinishedMessage> {
    await this.deps.publisher.send(message);
    return message;
  }
}
