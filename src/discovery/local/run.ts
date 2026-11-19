import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { SpecStore } from '../../scrape/spec/spec-store.js';
import { LocalFileObjectStore } from '../../scrape/storage/object-store.js';
import { ChromiumLauncher } from '../../scrape/runner/browser.js';
import { DiscoveryMessage, FinishedAttempt } from '../api/types.js';
import { AgentOutcome, runAgent } from '../worker/agent-runner.js';
import { DiscoverySession } from '../worker/agent-session.js';
import {
  BrowserLauncherWithProfile,
  DiscoveryWorker,
} from '../worker/discovery-worker.js';
import { LocalOptions } from './args.js';
import { LoadedInputs } from './inputs.js';
import { isBlockedAllowingPrivate } from './private-addresses.js';

export type LocalAgent = (
  session: DiscoverySession,
  message: DiscoveryMessage,
  abort: AbortController,
) => Promise<AgentOutcome>;

export interface LocalRunDeps {
  agent?: LocalAgent;
  launcher?: BrowserLauncherWithProfile;
  /** Test hook; the run directory name is otherwise timestamp plus random. */
  attemptId?: string;
}

export interface LocalRunResult {
  attemptId: string;
  runDir: string;
  final: FinishedAttempt;
}

/** A run directory name that sorts by time and cannot collide with an earlier run. */
export function newAttemptId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * Runs the production worker with local surroundings: a file store under the
 * output root, an in-process publisher and the real model unless an agent is
 * given. Nothing here touches a database, a queue or AWS.
 */
export async function runLocalDiscovery(
  options: LocalOptions,
  inputs: LoadedInputs,
  deps: LocalRunDeps = {},
): Promise<LocalRunResult> {
  const attemptId = deps.attemptId ?? newAttemptId();
  const objects = new LocalFileObjectStore(options.outDir);
  const specs = new SpecStore(objects);

  let baseSpecKey: string | null = null;
  if (inputs.base) {
    baseSpecKey = `${attemptId}/base.json`;
    await specs.store(baseSpecKey, inputs.base);
  }

  const message: DiscoveryMessage = {
    attemptId,
    mode: options.mode,
    customerId: 'local',
    catalogId: 'local',
    siteId: 'local',
    siteUrl: options.url,
    snapshot: inputs.snapshot,
    targetProperties: inputs.targets,
    guidance: options.guidance,
    baseSpecKey,
    baseVersion: inputs.base ? 1 : null,
    caps: {
      maxTurns: options.maxTurns,
      maxDurationMs: options.maxMinutes * 60_000,
      maxCostUsd: options.maxCostUsd,
    },
    outputPrefix: attemptId,
  };

  let final: FinishedAttempt | undefined;
  const launcher = deps.launcher ?? new ChromiumLauncher();
  const worker = new DiscoveryWorker({
    objects,
    specs,
    publisher: {
      send: async (m) => {
        if (m.outcome !== 'started') final = m;
      },
    },
    launcher: { launch: (o) => launcher.launch(o) },
    agent:
      deps.agent ??
      ((session, m, abortController) =>
        runAgent({
          message: m,
          session,
          abortController,
          model: options.model,
        })),
    ...(options.allowPrivate
      ? {
          isBlocked: isBlockedAllowingPrivate,
          guardOptions: { isBlocked: isBlockedAllowingPrivate },
        }
      : {}),
  });
  const reported = await worker.handle(message);
  final ??= reported;
  await objects.put(`${attemptId}/result.json`, JSON.stringify(final, null, 2));
  return { attemptId, runDir: resolve(join(options.outDir, attemptId)), final };
}
