import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SpecStore } from '../../scrape/spec/spec-store.js';
import { S3ObjectStore } from '../../scrape/storage/object-store.js';
import { ChromiumLauncher } from '../../scrape/runner/browser.js';
import { runQueueLoop } from '../../scrape/worker/queue-loop.js';
import { DiscoveryMessage, FinishedAttempt } from '../api/types.js';
import { runAgent } from './agent-runner.js';
import { DiscoveryWorker } from './discovery-worker.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function parseMessage(body: unknown): DiscoveryMessage {
  const m = body as Partial<DiscoveryMessage> | null;
  if (
    !m ||
    typeof m.attemptId !== 'string' ||
    typeof m.siteUrl !== 'string' ||
    !m.snapshot ||
    !m.caps ||
    !m.outputPrefix
  )
    throw new Error('invalid discovery message');
  return m as DiscoveryMessage;
}

/** Fargate service entrypoint: one attempt at a time, scaled 0 to 2 tasks by queue depth. */
if (process.argv[1]?.endsWith('discovery/worker/main.js')) {
  const objects = new S3ObjectStore(
    new S3Client({}),
    required('RESULTS_BUCKET'),
  );
  const sqs = new SQSClient({});
  const finishedUrl = required('DISCOVERY_FINISHED_QUEUE_URL');
  const launcher = new ChromiumLauncher();
  const worker = new DiscoveryWorker({
    objects,
    specs: new SpecStore(objects),
    publisher: {
      send: async (m: FinishedAttempt) => {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: finishedUrl,
            MessageBody: JSON.stringify(m),
          }),
        );
      },
    },
    launcher: { launch: (o) => launcher.launch(o) },
    agent: (session, message, abortController) =>
      runAgent({
        message,
        session,
        abortController,
        model: process.env.DISCOVERY_MODEL,
      }),
  });
  let stop = false;
  process.on('SIGTERM', () => (stop = true));
  await runQueueLoop({
    client: sqs,
    queueUrl: required('DISCOVERY_QUEUE_URL'),
    handle: async (body) => {
      await worker.handle(parseMessage(body));
    },
    maxRunMs: Number(process.env.MAX_RUN_MS ?? 3_600_000),
    heartbeatMs: 60_000,
    visibilitySeconds: 300,
    shouldStop: () => stop,
    onError: (error) => console.error('discovery attempt failed', error),
  });
}
