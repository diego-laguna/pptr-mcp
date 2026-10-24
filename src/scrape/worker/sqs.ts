import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { FinishedMessage } from '../contracts/messages.js';
import { FinishedPublisher } from './worker.js';

export class SqsFinishedPublisher implements FinishedPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(message: FinishedMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  }
}
