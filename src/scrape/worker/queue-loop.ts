import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export interface QueueLoopOptions {
  client: Pick<SQSClient, 'send'>;
  queueUrl: string;
  /** Processes one message body; a throw leaves the message for redelivery. */
  handle(body: unknown, remainingMs: () => number): Promise<void>;
  /** Longest a single message may take. */
  maxRunMs: number;
  /** How often the message's visibility is extended while it is processed. */
  heartbeatMs: number;
  /** Visibility timeout (seconds) applied at each heartbeat. */
  visibilitySeconds: number;
  shouldStop: () => boolean;
  onError?: (error: unknown) => void;
}

/**
 * Long-polls an SQS queue one message at a time, extends the message's
 * visibility while it is processed (so a FIFO message group stays locked), and
 * deletes it only after the handler succeeds.
 */
export async function runQueueLoop(options: QueueLoopOptions): Promise<void> {
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
        await options.handle(
          JSON.parse(m.Body ?? 'null'),
          () => options.maxRunMs - (Date.now() - started),
        );
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
