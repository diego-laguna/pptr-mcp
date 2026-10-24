import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../catalog/errors.js';
import { ActiveSpecResolver } from '../../scrape/api/active-spec.js';
import { SpecStore } from '../../scrape/spec/spec-store.js';
import { SelectorSpec } from '../../scrape/spec/selector-spec.js';
import { specKey } from '../../scrape/storage/keys.js';
import {
  assertSafeSiteUrl,
  HostResolver,
  systemResolver,
  UnsafeUrlError,
} from '../safety/url-safety.js';
import { AttemptsRepository } from './attempts.repository.js';
import { resolveTargets, TargetError } from './targets.js';
import { SpecVersionsRepository } from './spec-versions.repository.js';
import {
  AdmissionPolicy,
  Caps,
  DiscoveryMessage,
  DiscoveryMode,
  DiscoveryQueue,
  DISCOVERY_MODES,
} from './types.js';
import { discoveryOutputPrefix } from './keys.js';

export const MAX_GUIDANCE_LENGTH = 2000;

export class InvalidDiscoveryRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDiscoveryRequestError';
  }
}
export class NoBaseSpecError extends Error {
  readonly code = 'no_base_spec';
  constructor(mode: DiscoveryMode) {
    super(
      mode === 'repair'
        ? 'a repair needs an active spec version for the site'
        : 'an incremental discovery needs an existing spec version to extend',
    );
    this.name = 'NoBaseSpecError';
  }
}
export class BudgetExhaustedError extends Error {
  readonly reason = 'budget_exhausted';
  constructor(detail?: string) {
    super(detail ?? 'the allowance for discovery attempts is exhausted');
    this.name = 'BudgetExhaustedError';
  }
}

export interface DiscoveryRequest {
  siteId: string;
  mode: DiscoveryMode;
  properties?: string[];
  guidance?: string;
}

export interface DiscoveryDeps {
  attempts: AttemptsRepository;
  versions: SpecVersionsRepository;
  specs: SpecStore;
  active: ActiveSpecResolver;
  queue: DiscoveryQueue;
  admission: AdmissionPolicy;
  caps: Caps;
  resolveHost?: HostResolver;
}

@Injectable()
export class DiscoveryRequestService {
  constructor(private readonly deps: DiscoveryDeps) {}

  async request(
    request: DiscoveryRequest,
  ): Promise<{ attemptId: string; created: boolean }> {
    const { attempts, queue } = this.deps;
    validateShape(request);

    const site = await attempts.siteForDiscovery(request.siteId);
    if (!site) throw new NotFoundError('site');

    // A site has one pending attempt; asking again is answered with it.
    const pending = await attempts.findPending(site.siteId);
    if (pending) return { attemptId: pending.id, created: false };

    try {
      await assertSafeSiteUrl(
        site.url,
        this.deps.resolveHost ?? systemResolver,
      );
    } catch (error) {
      if (error instanceof UnsafeUrlError)
        throw new InvalidDiscoveryRequestError(error.message);
      throw error;
    }

    const { baseVersion, base } = await this.resolveBase(
      request.mode,
      site.customerId,
      site.siteId,
    );
    let targets: string[];
    try {
      targets = resolveTargets({
        mode: request.mode,
        requested: request.properties,
        snapshot: site.snapshot,
        base,
        failingFromLastScrape:
          request.mode === 'repair' && !request.properties?.length
            ? await attempts.latestFailingProperties(site.siteId)
            : [],
      });
    } catch (error) {
      if (error instanceof TargetError)
        throw new InvalidDiscoveryRequestError(error.message);
      throw error;
    }

    const decision = await this.deps.admission.check({
      customerId: site.customerId,
      siteId: site.siteId,
      mode: request.mode,
    });
    if (!decision.allowed) throw new BudgetExhaustedError(decision.reason);

    const { attempt, created } = await attempts.createOrGetPending({
      siteId: site.siteId,
      mode: request.mode,
      targetProperties: targets,
      guidance: request.guidance?.trim() || null,
      baseVersion,
      snapshot: site.snapshot,
    });
    if (!created) return { attemptId: attempt.id, created: false };

    const message: DiscoveryMessage = {
      attemptId: attempt.id,
      mode: request.mode,
      customerId: site.customerId,
      catalogId: site.catalogId,
      siteId: site.siteId,
      siteUrl: site.url,
      snapshot: site.snapshot,
      targetProperties: targets,
      guidance: attempt.guidance,
      baseSpecKey:
        baseVersion === null
          ? null
          : specKey(site.customerId, site.siteId, baseVersion),
      baseVersion,
      caps: this.deps.caps,
      outputPrefix: discoveryOutputPrefix(
        site.customerId,
        site.siteId,
        attempt.id,
      ),
    };
    try {
      await queue.send(message);
    } catch (error) {
      await attempts.markFailed(attempt.id, {
        reason: 'error',
        detail: 'the attempt could not be enqueued',
      });
      throw error;
    }
    return { attemptId: attempt.id, created: true };
  }

  private async resolveBase(
    mode: DiscoveryMode,
    customerId: string,
    siteId: string,
  ): Promise<{ baseVersion: number | null; base: SelectorSpec | null }> {
    if (mode === 'full') return { baseVersion: null, base: null };
    const active = await this.deps.active.resolve(customerId, siteId);
    const baseVersion =
      mode === 'repair'
        ? active
        : (active ?? (await this.deps.versions.latestVersion(siteId)));
    if (baseVersion === null) throw new NoBaseSpecError(mode);
    const base = await this.deps.specs.load(
      specKey(customerId, siteId, baseVersion),
    );
    return { baseVersion, base };
  }
}

function validateShape(request: DiscoveryRequest): void {
  if (!DISCOVERY_MODES.includes(request.mode))
    throw new InvalidDiscoveryRequestError(
      `mode must be one of ${DISCOVERY_MODES.join(', ')}`,
    );
  if (request.guidance !== undefined) {
    if (typeof request.guidance !== 'string')
      throw new InvalidDiscoveryRequestError('guidance must be text');
    if (request.guidance.length > MAX_GUIDANCE_LENGTH)
      throw new InvalidDiscoveryRequestError(
        `guidance is limited to ${MAX_GUIDANCE_LENGTH} characters`,
      );
  }
  if (
    request.properties !== undefined &&
    (!Array.isArray(request.properties) ||
      !request.properties.every((p) => typeof p === 'string'))
  )
    throw new InvalidDiscoveryRequestError(
      'properties must be a list of names',
    );
}
