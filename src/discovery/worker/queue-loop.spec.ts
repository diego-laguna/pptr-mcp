import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { runQueueLoop } from '../../scrape/worker/queue-loop.js';

describe('runQueueLoop heartbeat for discovery attempts', () => {
  it('keeps a long attempt invisible and deletes it when done; leaves a failed one', async () => {
    for (const fail of [false, true]) {
      const sent: unknown[] = [];
      let delivered = false;
      const client = {
        send: async (c: unknown) => {
          sent.push(c);
          if (c instanceof ReceiveMessageCommand) {
            if (delivered) return {};
            delivered = true;
            return {
              Messages: [{ Body: '{"attemptId":"a"}', ReceiptHandle: 'h' }],
            };
          }
          return {};
        },
      };
      let polls = 0;
      await runQueueLoop({
        client: client as never,
        queueUrl: 'q',
        handle: () =>
          new Promise((resolve, reject) =>
            setTimeout(
              () => (fail ? reject(new Error('boom')) : resolve()),
              100,
            ),
          ),
        maxRunMs: 5000,
        heartbeatMs: 20,
        visibilitySeconds: 300,
        shouldStop: () => polls++ > 0,
        onError: () => undefined,
      });
      const kinds = sent.map((c) => (c as object).constructor);
      expect(
        kinds.filter((k) => k === ChangeMessageVisibilityCommand).length,
      ).toBeGreaterThanOrEqual(2);
      expect(kinds.includes(DeleteMessageCommand)).toBe(!fail);
    }
  });
});
