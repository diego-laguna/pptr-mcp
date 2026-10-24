import { Injectable } from '@nestjs/common';
import pg from 'pg';
import { withTransaction } from '../../database/transaction.js';
import {
  InvalidSpecError,
  validateSelectorSpec,
} from '../../scrape/spec/spec-validator.js';
import { SpecStore } from '../../scrape/spec/spec-store.js';
import { specKey } from '../../scrape/storage/keys.js';
import { ObjectStore } from '../../scrape/storage/object-store.js';
import { AttemptsRepository } from './attempts.repository.js';
import { FinishedAttempt, AttemptContext } from './types.js';

export class InvalidFinishedAttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFinishedAttemptError';
  }
}

export function parseFinishedAttempt(input: unknown): FinishedAttempt {
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof o.attemptId !== 'string' || o.attemptId === '')
    throw new InvalidFinishedAttemptError('attemptId is required');
  if (
    o.outcome !== 'started' &&
    o.outcome !== 'candidate' &&
    o.outcome !== 'failed'
  )
    throw new InvalidFinishedAttemptError(
      'outcome must be started, candidate or failed',
    );
  if (o.outcome === 'candidate' && typeof o.candidateKey !== 'string')
    throw new InvalidFinishedAttemptError('a candidate needs a candidateKey');
  if (o.outcome === 'failed' && typeof o.reason !== 'string')
    throw new InvalidFinishedAttemptError('a failure needs a reason');
  return o as unknown as FinishedAttempt;
}

export interface DiscoveryFinalizerDeps {
  pool: pg.Pool;
  attempts: AttemptsRepository;
  specs: SpecStore;
  objects: ObjectStore;
}

/** Consumes the finished-attempt queue: stores verified candidates as immutable versions. */
@Injectable()
export class DiscoveryFinalizer {
  constructor(private readonly deps: DiscoveryFinalizerDeps) {}

  async handle(body: unknown): Promise<void> {
    const message = parseFinishedAttempt(body);
    const attempt = await this.deps.attempts.getContext(message.attemptId);
    if (!attempt) return;
    if (attempt.status === 'candidate_ready' || attempt.status === 'failed')
      return; // redelivery

    if (message.outcome === 'started')
      return this.deps.attempts.markRunning(attempt.id);
    if (message.outcome === 'failed') {
      return this.deps.attempts.markFailed(attempt.id, {
        reason: message.reason!,
        detail: message.detail,
        usage: message.usage,
        evidenceKey: message.evidenceKey,
      });
    }
    await this.storeCandidate(attempt, message);
  }

  /** A discovery message that exhausted its receives without being reported. */
  async handleDeadLetter(attemptId: string): Promise<void> {
    const attempt = await this.deps.attempts.getContext(attemptId);
    if (
      !attempt ||
      attempt.status === 'candidate_ready' ||
      attempt.status === 'failed'
    )
      return;
    await this.deps.attempts.markFailed(attemptId, {
      reason: 'error',
      detail:
        'the attempt failed repeatedly and was moved to the dead-letter queue',
    });
  }

  private async storeCandidate(
    attempt: AttemptContext,
    message: FinishedAttempt,
  ) {
    const { attempts, objects, specs, pool } = this.deps;
    const fail = (
      reason: 'invalid_output' | 'schema_changed' | 'error',
      detail: string,
    ) =>
      attempts.markFailed(attempt.id, {
        reason,
        detail,
        usage: message.usage,
        evidenceKey: message.evidenceKey,
      });

    const body = await objects.get(message.candidateKey!);
    if (body === null) return fail('error', 'the candidate object is missing');
    let candidate;
    try {
      candidate = validateSelectorSpec(JSON.parse(body));
    } catch (error) {
      return fail(
        'invalid_output',
        error instanceof InvalidSpecError
          ? error.message
          : 'the candidate is not valid JSON',
      );
    }

    // Every bound property must still exist; properties added since do not block.
    const site = await attempts.siteForDiscovery(attempt.siteId);
    const current = new Set(site?.snapshot.properties.map((p) => p.name));
    const missing = Object.keys(candidate.properties).filter(
      (n) => !current.has(n),
    );
    if (missing.length > 0)
      return fail(
        'schema_changed',
        `no longer in the schema: ${missing.join(', ')}`,
      );

    await withTransaction(pool, async (client) => {
      // Serialize finalizations per site so numbers are consecutive and distinct.
      await client.query('SELECT 1 FROM sites WHERE id = $1 FOR UPDATE', [
        attempt.siteId,
      ]);
      const { rows } = await client.query(
        'SELECT coalesce(max(version), 0) + 1 AS next FROM site_spec_versions WHERE site_id = $1',
        [attempt.siteId],
      );
      const version = rows[0].next as number;
      await specs.store(
        specKey(attempt.customerId, attempt.siteId, version),
        candidate,
      );
      await client.query(
        `INSERT INTO site_spec_versions
           (site_id, version, mode, attempt_id, base_version, schema_version, bound_properties)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          attempt.siteId,
          version,
          attempt.mode,
          attempt.id,
          attempt.baseVersion,
          attempt.schemaVersion,
          Object.keys(candidate.properties),
        ],
      );
      await client.query(
        `UPDATE discovery_attempts
            SET status = 'candidate_ready', spec_version = $2, usage = $3, evidence_key = $4, finished_at = now()
          WHERE id = $1`,
        [
          attempt.id,
          version,
          message.usage ? JSON.stringify(message.usage) : null,
          message.evidenceKey ?? null,
        ],
      );
    });
  }
}
