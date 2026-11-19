import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { parseScrapeMessage, ScrapeMessage } from '../contracts/messages.js';
import { ChromiumLauncher } from '../runner/browser.js';
import { runWithBrowser } from '../runner/runner.js';
import { SpecStore } from '../spec/spec-store.js';
import { S3ObjectStore } from '../storage/object-store.js';
import { QueueLoopOptions, runQueueLoop } from './queue-loop.js';
import { SqsFinishedPublisher } from './sqs.js';
import { ScrapeWorker } from './worker.js';

export interface FargateLoopOptions extends Omit<QueueLoopOptions, 'handle'> {
  worker: Pick<ScrapeWorker, 'handle'>;
}

/**
 * Fallback runtime for sites whose runs outgrow Lambda: the same worker, fed
 * by the same queue, with a heartbeat that keeps the message invisible while
 * the scrape runs. Failures leave the message for redelivery, as on Lambda.
 */
export function runFargateLoop(options: FargateLoopOptions): Promise<void> {
  const { worker, ...loop } = options;
  return runQueueLoop({
    ...loop,
    handle: async (body, remainingMs) => {
      const message: ScrapeMessage = parseScrapeMessage(body);
      await worker.handle(message, { remainingMs });
    },
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

if (process.argv[1]?.endsWith('fargate-main.js')) {
  const objects = new S3ObjectStore(
    new S3Client({}),
    required('RESULTS_BUCKET'),
  );
  const sqs = new SQSClient({});
  const launcher = new ChromiumLauncher();
  let stop = false;
  process.on('SIGTERM', () => (stop = true));
  await runFargateLoop({
    client: sqs,
    queueUrl: required('SCRAPE_QUEUE_URL'),
    worker: new ScrapeWorker({
      specs: new SpecStore(objects),
      results: objects,
      publisher: new SqsFinishedPublisher(sqs, required('RESULTS_QUEUE_URL')),
      execute: (spec, options) => runWithBrowser(launcher, spec, options),
    }),
    maxRunMs: Number(process.env.MAX_RUN_MS ?? 3_600_000),
    heartbeatMs: 60_000,
    visibilitySeconds: 300,
    shouldStop: () => stop,
    onError: (error) => console.error('scrape failed', error),
  });
}
