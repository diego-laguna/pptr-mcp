import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { parseScrapeMessage } from '../contracts/messages.js';
import { ChromiumLauncher } from '../runner/browser.js';
import { runWithBrowser } from '../runner/runner.js';
import { SpecStore } from '../spec/spec-store.js';
import { S3ObjectStore } from '../storage/object-store.js';
import { SqsFinishedPublisher } from './sqs.js';
import { ScrapeWorker } from './worker.js';

interface SqsEvent {
  Records: { messageId: string; body: string }[];
}
interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

let worker: ScrapeWorker | undefined;

function build(): ScrapeWorker {
  const bucket = required('RESULTS_BUCKET');
  const objects = new S3ObjectStore(new S3Client({}), bucket);
  const launcher = new ChromiumLauncher();
  return new ScrapeWorker({
    specs: new SpecStore(objects),
    results: objects,
    publisher: new SqsFinishedPublisher(
      new SQSClient({}),
      required('RESULTS_QUEUE_URL'),
    ),
    execute: (spec, options) => runWithBrowser(launcher, spec, options),
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * SQS event source handler (batch size 1). Failing records are reported back so
 * only they are redelivered, and go to the DLQ after the queue's receive limit.
 */
export async function handler(event: SqsEvent, context: LambdaContext) {
  worker ??= build();
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await worker.handle(parseScrapeMessage(JSON.parse(record.body)), {
        remainingMs: () => context.getRemainingTimeInMillis(),
      });
    } catch (error) {
      console.error('scrape failed', record.messageId, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
