import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { SelectorSpec } from '../../scrape/spec/selector-spec.js';
import { SpecStore } from '../../scrape/spec/spec-store.js';
import { ObjectStore } from '../../scrape/storage/object-store.js';
import {
  DiscoveryFailureReason,
  DiscoveryMessage,
  FinishedAttempt,
  Usage,
} from '../api/types.js';
import {
  assertSafeSiteUrl,
  HostResolver,
  systemResolver,
  UnsafeUrlError,
} from '../safety/url-safety.js';
import { captureAnnotated } from '../verify/annotate.js';
import {
  buildEvidence,
  Evidence,
  GuardEvent,
  ScreenshotRecord,
  unresolvedOf,
} from '../verify/evidence.js';
import { VerifyThresholds } from '../verify/verifier.js';
import { AgentOutcome, reasonForNoCandidate } from './agent-runner.js';
import { DiscoverySession } from './agent-session.js';
import { BrowsingGuard, installBrowsingGuard } from './browsing-guard.js';

export interface FinishedAttemptPublisher {
  send(message: FinishedAttempt): Promise<void>;
}

export interface BrowserLauncherWithProfile {
  launch(options: { userDataDir: string }): Promise<Browser>;
}

export interface DiscoveryWorkerDeps {
  objects: ObjectStore;
  specs: SpecStore;
  publisher: FinishedAttemptPublisher;
  launcher: BrowserLauncherWithProfile;
  /** Runs the model against the session; replaced by a scripted double in tests. */
  agent(
    session: DiscoverySession,
    message: DiscoveryMessage,
    abort: AbortController,
  ): Promise<AgentOutcome>;
  previewLimits?: { maxPages: number; maxItems: number };
  thresholds?: Partial<VerifyThresholds>;
  resolveHost?: HostResolver;
  /** Test hook for the guard's address predicate. */
  guardOptions?: {
    isBlocked?: (address: string) => boolean;
    resolveHost?: HostResolver;
  };
  now?: () => number;
}

/**
 * Stateless and without database access: it reads the message, drives the
 * agent in a guarded browser, and writes the candidate and evidence to object
 * storage under the owner's prefix. A fresh browser profile is used and removed
 * for every attempt. Infrastructure errors are thrown so the queue redelivers.
 */
export class DiscoveryWorker {
  constructor(private readonly deps: DiscoveryWorkerDeps) {}

  async handle(message: DiscoveryMessage): Promise<FinishedAttempt> {
    const { publisher, objects } = this.deps;
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    await publisher.send({ attemptId: message.attemptId, outcome: 'started' });

    const evidenceKey = `${message.outputPrefix}/evidence.json`;
    const finishFailed = async (
      reason: DiscoveryFailureReason,
      detail: string,
      usage: Usage,
      evidence?: Evidence,
    ) => {
      if (evidence) await objects.put(evidenceKey, JSON.stringify(evidence));
      return this.report({
        attemptId: message.attemptId,
        outcome: 'failed',
        reason,
        detail,
        usage,
        ...(evidence ? { evidenceKey } : {}),
      });
    };
    const elapsed = (): Usage => ({ turns: 0, durationMs: now() - startedAt });

    try {
      await assertSafeSiteUrl(
        message.siteUrl,
        this.deps.resolveHost ?? systemResolver,
      );
    } catch (error) {
      if (error instanceof UnsafeUrlError)
        return finishFailed('unreachable_site', error.message, elapsed());
      throw error;
    }

    const base: SelectorSpec | null = message.baseSpecKey
      ? await this.deps.specs.load(message.baseSpecKey)
      : null;

    const profile = await mkdtemp(join(tmpdir(), 'discovery-'));
    let browser: Browser | undefined;
    try {
      browser = await this.deps.launcher.launch({ userDataDir: profile });
      const page = await browser.newPage();
      const guardEvents: GuardEvent[] = [];
      const guard: BrowsingGuard = await installBrowsingGuard(page, {
        siteUrl: message.siteUrl,
        onEvent: (e) => guardEvents.push(e),
        ...this.deps.guardOptions,
      });
      const abort = new AbortController();
      const session = new DiscoverySession({
        message,
        base,
        page,
        guard,
        deadline: startedAt + message.caps.maxDurationMs,
        previewLimits: this.deps.previewLimits ?? { maxPages: 2, maxItems: 40 },
        thresholds: this.deps.thresholds,
        onFinished: () => abort.abort(),
      });

      const outcome = await this.deps.agent(session, message, abort);
      const usage: Usage = {
        ...outcome.usage,
        durationMs: Math.max(outcome.usage.durationMs, now() - startedAt),
      };

      const scope =
        message.mode === 'full'
          ? message.snapshot.properties.map((p) => p.name)
          : message.targetProperties;

      if (session.accepted) {
        const {
          spec,
          verification,
          comparisons,
          unresolved: stated,
          notes,
        } = session.accepted;
        const screenshots = await this.captureScreenshots(
          message,
          spec,
          page,
          objects,
        );
        const evidence = buildEvidence({
          outcome: 'candidate',
          mode: message.mode,
          targets: message.targetProperties,
          spec,
          verification,
          unresolved: unresolvedOf(
            spec,
            scope,
            message.snapshot.variantProperty,
            stated,
          ),
          guardEvents,
          notes,
          comparisons,
          screenshots,
        });
        const candidateKey = `${message.outputPrefix}/candidate.json`;
        await objects.put(candidateKey, JSON.stringify(spec));
        await objects.put(evidenceKey, JSON.stringify(evidence));
        return this.report({
          attemptId: message.attemptId,
          outcome: 'candidate',
          candidateKey,
          evidenceKey,
          usage,
        });
      }

      const { reason, detail } = reasonForNoCandidate(session, outcome);
      const evidence = buildEvidence({
        outcome: 'failed',
        mode: message.mode,
        targets: message.targetProperties,
        spec: null,
        verification: null,
        unresolved: [],
        guardEvents,
        notes: [...session.notes, detail],
      });
      return finishFailed(reason, detail, usage, evidence);
    } finally {
      await browser?.close().catch(() => undefined);
      await rm(profile, { recursive: true, force: true });
    }
  }

  /** After verification: up to 3 pages with each bound element outlined and labelled. */
  private async captureScreenshots(
    message: DiscoveryMessage,
    spec: SelectorSpec,
    page: import('puppeteer-core').Page,
    objects: ObjectStore,
  ): Promise<ScreenshotRecord[]> {
    const listing = spec.steps.find((s) => s.type === 'open_url');
    if (!listing || listing.type !== 'open_url') return [];
    try {
      await page.goto(listing.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      const shot = await captureAnnotated(page, spec);
      const key = `${message.outputPrefix}/screenshots/1.png`;
      await objects.putBinary(key, shot.png, 'image/png');
      return [{ key, page: shot.url, notHighlighted: shot.notHighlighted }];
    } catch {
      return [];
    }
  }

  private async report(message: FinishedAttempt): Promise<FinishedAttempt> {
    await this.deps.publisher.send(message);
    return message;
  }
}
