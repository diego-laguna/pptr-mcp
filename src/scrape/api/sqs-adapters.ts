import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { FailedScrapeEvent, ScrapeMessage } from '../contracts/messages.js';
import { FailedScrapePublisherPort, ScrapeQueue } from './types.js';

export class SqsScrapeQueue implements ScrapeQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(
    message: ScrapeMessage,
    dedupe: { groupId: string; deduplicationId: string },
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: dedupe.groupId,
        MessageDeduplicationId: dedupe.deduplicationId,
      }),
    );
  }
}

export class SqsFailedScrapePublisher implements FailedScrapePublisherPort {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(event: FailedScrapeEvent): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ type: 'failed_scrape', ...event }),
      }),
    );
  }
}

/** Long-polls a queue and deletes a message only after the handler succeeds. */
export class QueuePoller {
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly handler: (body: unknown) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const out = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
          }),
        );
        for (const m of out.Messages ?? []) {
          try {
            await this.handler(JSON.parse(m.Body ?? 'null'));
            await this.client.send(
              new DeleteMessageCommand({
                QueueUrl: this.queueUrl,
                ReceiptHandle: m.ReceiptHandle,
              }),
            );
          } catch (error) {
            this.onError(error); // left on the queue; redelivered after the visibility timeout
          }
        }
      } catch (error) {
        this.onError(error);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}
