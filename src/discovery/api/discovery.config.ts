import { Caps } from './types.js';

export interface DiscoveryConfig {
  discoveryQueueUrl: string;
  finishedQueueUrl: string;
  caps: Caps;
  /** Starts the finished-attempt consumer in this process. */
  runConsumers: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value)
    throw new Error(
      `${name} is not set; the discovery module needs it to start`,
    );
  return value;
}

function positive(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

/** Cap defaults are provisional until real attempts are measured (docs/discovery.md). */
export function loadDiscoveryConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiscoveryConfig {
  return {
    discoveryQueueUrl: required(env, 'DISCOVERY_QUEUE_URL'),
    finishedQueueUrl: required(env, 'DISCOVERY_FINISHED_QUEUE_URL'),
    caps: {
      maxTurns: Math.floor(positive(env, 'DISCOVERY_MAX_TURNS', 60)),
      maxDurationMs: positive(env, 'DISCOVERY_MAX_MINUTES', 20) * 60_000,
      maxCostUsd: positive(env, 'DISCOVERY_MAX_COST_USD', 5),
    },
    runConsumers: env.SCRAPE_CONSUMERS === 'true',
  };
}
