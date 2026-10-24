import { ScrapeMessage } from '../contracts/messages.js';
import { ScrapeQueue } from '../api/types.js';

export interface QueuedScrape {
  message: ScrapeMessage;
  groupId: string;
  deduplicationId: string;
  receiveCount: number;
}

/**
 * Test double with SQS semantics that matter here: redelivery on handler
 * failure, a dead-letter queue after maxReceiveCount, and FIFO dedupe ids.
 */
export class InMemoryScrapeQueue implements ScrapeQueue {
  readonly pending: QueuedScrape[] = [];
  readonly deadLetters: QueuedScrape[] = [];
  readonly sent: QueuedScrape[] = [];

  constructor(private readonly maxReceiveCount = 3) {}

  async send(
    message: ScrapeMessage,
    dedupe: { groupId: string; deduplicationId: string },
  ): Promise<void> {
    const entry = { message, ...dedupe, receiveCount: 0 };
    this.sent.push(entry);
    if (this.pending.some((p) => p.deduplicationId === dedupe.deduplicationId))
      return; // inside the dedupe window the duplicate is dropped
    this.pending.push(entry);
  }

  /** Delivers the next message; a throwing handler leaves it for redelivery. */
  async deliverNext(
    handler: (message: ScrapeMessage) => Promise<void>,
  ): Promise<'empty' | 'acked' | 'redelivery' | 'dead-lettered'> {
    const entry = this.pending[0];
    if (!entry) return 'empty';
    entry.receiveCount++;
    try {
      await handler(entry.message);
      this.pending.shift();
      return 'acked';
    } catch {
      if (entry.receiveCount >= this.maxReceiveCount) {
        this.pending.shift();
        this.deadLetters.push(entry);
        return 'dead-lettered';
      }
      return 'redelivery';
    }
  }
}
