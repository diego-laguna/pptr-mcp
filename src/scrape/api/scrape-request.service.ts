import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../catalog/errors.js';
import { ScrapeMessage, ScrapeMode } from '../contracts/messages.js';
import type { SpecStore } from '../spec/spec-store.js';
import { specKey } from '../storage/keys.js';
import type { ActiveSpecResolver } from './active-spec.js';
import { RunsRepository } from './runs.repository.js';
import type { ScrapeConfig } from './scrape.config.js';
import {
  ACTIVE_SPEC_RESOLVER,
  SCRAPE_CONFIG,
  SCRAPE_QUEUE,
  SPEC_STORE,
} from './tokens.js';
import type { ScrapeQueue } from './types.js';

export class NoActiveSpecError extends Error {
  readonly code = 'no_active_spec';
  constructor() {
    super('the site has no active spec');
    this.name = 'NoActiveSpecError';
  }
}

/** The request the endpoints and the schedule both express. */
export type ScrapeRequest =
  | { mode: 'production'; siteId: string }
  | { mode: 'preview'; siteId: string; specVersion: number };

export const productionRequest = (siteId: string): ScrapeRequest => ({
  mode: 'production',
  siteId,
});

export function parseScrapeRequest(input: unknown): ScrapeRequest {
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof o.siteId !== 'string' || o.siteId === '')
    throw new Error('siteId is required');
  if (o.mode === 'production') return productionRequest(o.siteId);
  if (
    o.mode === 'preview' &&
    typeof o.specVersion === 'number' &&
    Number.isInteger(o.specVersion) &&
    o.specVersion >= 1
  )
    return { mode: 'preview', siteId: o.siteId, specVersion: o.specVersion };
  throw new Error('invalid scrape request');
}

export function dedupeKeyOf(request: ScrapeRequest): string {
  return request.mode === 'production'
    ? `${request.siteId}:production`
    : `${request.siteId}:preview:${request.specVersion}`;
}

@Injectable()
export class ScrapeRequestService {
  constructor(
    @Inject(RunsRepository) private readonly runs: RunsRepository,
    @Inject(SPEC_STORE) private readonly specs: SpecStore,
    @Inject(ACTIVE_SPEC_RESOLVER) private readonly active: ActiveSpecResolver,
    @Inject(SCRAPE_QUEUE) private readonly queue: ScrapeQueue,
    @Inject(SCRAPE_CONFIG)
    private readonly config: Pick<ScrapeConfig, 'previewLimits'>,
  ) {}

  /** Records a run and enqueues it; a pending duplicate is answered with the existing run id. */
  async request(
    request: ScrapeRequest,
  ): Promise<{ runId: string; created: boolean }> {
    const site = await this.runs.siteContext(request.siteId);
    if (!site) throw new NotFoundError('site');

    let specVersion: number;
    if (request.mode === 'production') {
      const active = await this.active.resolve(site.customerId, site.siteId);
      if (active === null) throw new NoActiveSpecError();
      specVersion = active;
    } else {
      specVersion = request.specVersion;
      if (
        !(await this.specs.exists(
          specKey(site.customerId, site.siteId, specVersion),
        ))
      )
        throw new NotFoundError('spec version');
    }

    const { run, created } = await this.runs.createOrGetPending(
      site.customerId,
      {
        siteId: site.siteId,
        mode: request.mode as ScrapeMode,
        specVersion,
        schemaVersion: site.schemaVersion,
      },
    );
    if (!created) return { runId: run.id, created: false };

    const message: ScrapeMessage = {
      runId: run.id,
      mode: request.mode,
      customerId: site.customerId,
      catalogId: site.catalogId,
      siteId: site.siteId,
      specKey: specKey(site.customerId, site.siteId, specVersion),
      specVersion,
      schemaVersion: site.schemaVersion,
      schema: site.schema,
      ...(request.mode === 'preview'
        ? { limits: this.config.previewLimits }
        : {}),
    };
    try {
      await this.queue.send(message, {
        groupId: site.siteId,
        deduplicationId: dedupeKeyOf(request),
      });
    } catch (error) {
      // Do not leave a queued run that nothing will ever pick up; it would block future requests.
      await this.runs.markFailed(run.id, {
        reason: 'error',
        detail: 'the request could not be enqueued',
      });
      throw error;
    }
    return { runId: run.id, created: true };
  }
}
