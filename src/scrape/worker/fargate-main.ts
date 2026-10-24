import { S3Client } from '@aws-sdk/client-s3';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { parseScrapeMessage, ScrapeMessage } from '../contracts/messages.js';
import { ChromiumLauncher } from '../runner/browser.js';
import { runWithBrowser } from '../runner/runner.js';
import { SpecStore } from '../spec/spec-store.js';
import { S3ObjectStore } from '../storage/object-store.js';
import { SqsFinishedPublisher } from './sqs.js';
import { ScrapeWorker } from './worker.js';

export interface FargateLoopOptions {
  client: Pick<SQSClient, 'send'>;
  queueUrl: string;
  worker: Pick<ScrapeWorker, 'handle'>;
  /** Longest a single scrape may run. */
  maxRunMs: number;
  /** How often the message's visibility is extended while it runs. */
  heartbeatMs: number;
  /** Visibility timeout (seconds) applied at each heartbeat. */
  visibilitySeconds: number;
  shouldStop: () => boolean;
  onError?: (error: unknown) => void;
}

/**
 * Fallback runtime for sites whose runs outgrow Lambda: the same worker, fed
 * by the same queue, with a heartbeat that keeps the message invisible while
 * the scrape runs. Failures leave the message for redelivery, as on Lambda.
 */
export async function runFargateLoop(
  options: FargateLoopOptions,
): Promise<void> {
  const { client, queueUrl } = options;
  while (!options.shouldStop()) {
    const out = (await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: options.visibilitySeconds,
      }),
    )) as { Messages?: { Body?: string; ReceiptHandle?: string }[] };
    for (const m of out.Messages ?? []) {
      const started = Date.now();
      const heartbeat = setInterval(() => {
        void client
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: m.ReceiptHandle,
              VisibilityTimeout: options.visibilitySeconds,
            }),
          )
          .catch((error) => options.onError?.(error));
      }, options.heartbeatMs);
      try {
        const message: ScrapeMessage = parseScrapeMessage(
          JSON.parse(m.Body ?? 'null'),
        );
        await options.worker.handle(message, {
          remainingMs: () => options.maxRunMs - (Date.now() - started),
        });
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: m.ReceiptHandle,
          }),
        );
      } catch (error) {
        options.onError?.(error);
      } finally {
        clearInterval(heartbeat);
      }
    }
  }
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
