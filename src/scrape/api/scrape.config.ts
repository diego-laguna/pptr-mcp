export interface ScrapeConfig {
  scrapeQueueUrl: string;
  resultsQueueUrl: string;
  failedScrapeQueueUrl: string;
  /** Queue that scheduled ticks are delivered to. */
  triggerQueueUrl: string;
  resultsBucket: string;
  internalApiToken: string;
  previewLimits: { maxPages: number; maxItems: number };
  /** Starts the results and dead-letter pollers in this process. */
  runConsumers: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set; the scrape module needs it to start`);
  }
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

export function loadScrapeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ScrapeConfig {
  return {
    scrapeQueueUrl: required(env, 'SCRAPE_QUEUE_URL'),
    resultsQueueUrl: required(env, 'RESULTS_QUEUE_URL'),
    failedScrapeQueueUrl: required(env, 'FAILED_SCRAPE_QUEUE_URL'),
    triggerQueueUrl: required(env, 'TRIGGER_QUEUE_URL'),
    resultsBucket: required(env, 'RESULTS_BUCKET'),
    internalApiToken: required(env, 'INTERNAL_API_TOKEN'),
    previewLimits: {
      maxPages: positiveInt(env, 'PREVIEW_MAX_PAGES', 2),
      maxItems: positiveInt(env, 'PREVIEW_MAX_ITEMS', 20),
    },
    runConsumers: env.SCRAPE_CONSUMERS === 'true',
  };
}
