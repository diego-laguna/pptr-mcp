import {
  InvalidMessageError,
  parseFinishedMessage,
  parseScrapeMessage,
} from './messages.js';

import { productionMessage } from './fixtures.js';

describe('parseScrapeMessage', () => {
  it('accepts production and preview messages', () => {
    expect(parseScrapeMessage(productionMessage)).toEqual(productionMessage);
    const preview = {
      ...productionMessage,
      mode: 'preview',
      limits: { maxPages: 1, maxItems: 10 },
    };
    expect(parseScrapeMessage(preview).limits).toEqual({
      maxPages: 1,
      maxItems: 10,
    });
  });

  it.each([
    ['not an object', 'x'],
    ['missing run id', { ...productionMessage, runId: undefined }],
    ['missing schema', { ...productionMessage, schema: undefined }],
    ['bad mode', { ...productionMessage, mode: 'other' }],
    [
      'non-integer schema version',
      { ...productionMessage, schemaVersion: 1.5 },
    ],
    ['preview without limits', { ...productionMessage, mode: 'preview' }],
    [
      'production with limits',
      { ...productionMessage, limits: { maxPages: 1, maxItems: 1 } },
    ],
  ])('rejects %s', (_n, input) => {
    expect(() => parseScrapeMessage(input)).toThrow(InvalidMessageError);
  });
});

describe('parseFinishedMessage', () => {
  it('accepts success and failure', () => {
    expect(
      parseFinishedMessage({
        runId: 'r1',
        outcome: 'succeeded',
        resultKey: 'k',
      }).outcome,
    ).toBe('succeeded');
    expect(
      parseFinishedMessage({
        runId: 'r1',
        outcome: 'failed',
        reason: 'timeout',
      }).reason,
    ).toBe('timeout');
  });

  it.each([
    ['unknown reason', { runId: 'r1', outcome: 'failed', reason: 'nope' }],
    ['failed without reason', { runId: 'r1', outcome: 'failed' }],
    ['succeeded without result', { runId: 'r1', outcome: 'succeeded' }],
    [
      'bad stats',
      {
        runId: 'r1',
        outcome: 'failed',
        reason: 'error',
        stats: { items: 'x' },
      },
    ],
  ])('rejects %s', (_n, input) => {
    expect(() => parseFinishedMessage(input)).toThrow(InvalidMessageError);
  });
});
