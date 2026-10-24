import { readFile } from 'node:fs/promises';
import { parseFinishedMessage, parseScrapeMessage } from './messages.js';

describe('docs/scrape-execution.md', () => {
  it('has example messages that pass the validators', async () => {
    const doc = await readFile(
      new URL('../../../docs/scrape-execution.md', import.meta.url),
      'utf8',
    );
    const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map(
      (m) => m[1],
    );
    const scrape = blocks.find((b) => b.includes('"specKey"'))!;
    const finished = blocks.find((b) => b.includes('"outcome"'))!;
    expect(parseScrapeMessage(JSON.parse(scrape)).mode).toBe('preview');
    expect(
      parseFinishedMessage(JSON.parse(finished.replaceAll('…', 'x'))).outcome,
    ).toBe('succeeded');
  });
});
