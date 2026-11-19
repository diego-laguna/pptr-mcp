import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { productionMessage } from '../contracts/fixtures.js';
import { runFargateLoop } from './fargate-main.js';

function fakeSqs(body: string) {
  const sent: unknown[] = [];
  let delivered = false;
  return {
    sent,
    send: async (command: unknown) => {
      sent.push(command);
      if (command instanceof ReceiveMessageCommand) {
        if (delivered) return {};
        delivered = true;
        return { Messages: [{ Body: body, ReceiptHandle: 'h1' }] };
      }
      return {};
    },
  };
}

const base = {
  queueUrl: 'q',
  maxRunMs: 10_000,
  heartbeatMs: 20,
  visibilitySeconds: 300,
};

describe('runFargateLoop', () => {
  it('extends visibility while a scrape runs and deletes the message afterwards', async () => {
    const client = fakeSqs(JSON.stringify(productionMessage));
    let polls = 0;
    await runFargateLoop({
      ...base,
      client: client as never,
      worker: {
        handle: () => new Promise((r) => setTimeout(() => r({} as never), 120)),
      },
      shouldStop: () => polls++ > 0,
    });
    const kinds = client.sent.map((c) => (c as object).constructor);
    expect(
      kinds.filter((k) => k === ChangeMessageVisibilityCommand).length,
    ).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain(DeleteMessageCommand);
  });

  it('leaves the message for redelivery when the scrape fails', async () => {
    const client = fakeSqs(JSON.stringify(productionMessage));
    const errors: unknown[] = [];
    let polls = 0;
    await runFargateLoop({
      ...base,
      client: client as never,
      worker: {
        handle: async () => {
          throw new Error('browser crashed');
        },
      },
      shouldStop: () => polls++ > 0,
      onError: (e) => errors.push(e),
    });
    expect(client.sent.map((c) => (c as object).constructor)).not.toContain(
      DeleteMessageCommand,
    );
    expect(errors).toHaveLength(1);
  });
});
