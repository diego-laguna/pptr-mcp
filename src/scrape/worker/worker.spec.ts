import { validSpec } from '../spec/spec-fixtures.js';
import { InMemoryObjectStore } from '../storage/object-store.js';
import { SpecStore } from '../spec/spec-store.js';
import { FinishedMessage, RunResult } from '../contracts/messages.js';
import { RawItem } from '../runner/extract.js';
import { ScrapeWorker } from './worker.js';
import { productionMessage } from '../contracts/fixtures.js';

const message = {
  ...productionMessage,
  schema: { properties: ['launch'], variantProperty: null },
} as never as import('../contracts/messages.js').ScrapeMessage;
const rawItem = (n: number): RawItem => ({
  system: {
    name: `Remera ${n}`,
    link: `https://shop.example/p/${n}`,
    price: '$ 1,00',
    thumbnail_url: null,
  },
  properties: { launch: '15/10/2026' },
  variants: [],
});

function setup(execute: (...a: never[]) => Promise<never> | Promise<unknown>) {
  const objects = new InMemoryObjectStore();
  const specs = new SpecStore(objects);
  const results = new InMemoryObjectStore();
  const sent: FinishedMessage[] = [];
  const worker = new ScrapeWorker({
    specs,
    results,
    publisher: { send: async (m) => void sent.push(m) },
    execute: execute as never,
    safetyMarginMs: 0,
  });
  return { objects, specs, results, sent, worker };
}

describe('ScrapeWorker', () => {
  it('stores a large result by reference and sends a small finished message', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => rawItem(i));
    const { specs, results, sent, worker } = setup(async () => ({
      finished: true,
      pages: 3,
      rawItems: many,
    }));
    await specs.store(message.specKey, validSpec() as never);

    const out = await worker.handle(message, { remainingMs: () => 60_000 });

    expect(out.outcome).toBe('succeeded');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]).length).toBeLessThan(1024);
    const stored = JSON.parse(
      (await results.get(out.resultKey!))!,
    ) as RunResult;
    expect(stored.items).toHaveLength(5000);
    expect(JSON.stringify(stored).length).toBeGreaterThan(256 * 1024);
    expect(out.resultKey).toBe(
      'customers/c1/catalogs/k1/sites/s1/runs/r1/result.json',
    );
    expect(stored.items[0].value.launch).toBe('2026-10-15');
  });

  it('reports no_spec without opening a browser', async () => {
    const execute = vi.fn();
    const { sent, worker } = setup(execute);
    const out = await worker.handle(message, { remainingMs: () => 1000 });
    expect(out).toMatchObject({ outcome: 'failed', reason: 'no_spec' });
    expect(execute).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it('reports invalid_spec without opening a browser', async () => {
    const execute = vi.fn();
    const { objects, worker } = setup(execute);
    await objects.put(message.specKey, JSON.stringify({ formatVersion: 7 }));
    const out = await worker.handle(message, { remainingMs: () => 1000 });
    expect(out).toMatchObject({ outcome: 'failed', reason: 'invalid_spec' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports schema_mismatch when the spec binds an undeclared property', async () => {
    const execute = vi.fn();
    const { specs, worker } = setup(execute);
    await specs.store(message.specKey, validSpec() as never);
    const renamed = {
      ...message,
      schema: { properties: ['release'], variantProperty: null },
    };
    const out = await worker.handle(renamed, { remainingMs: () => 1000 });
    expect(out).toMatchObject({ outcome: 'failed', reason: 'schema_mismatch' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports timeout with the partial result stored', async () => {
    const { specs, results, worker } = setup(async () => ({
      finished: false,
      pages: 1,
      rawItems: [rawItem(1)],
    }));
    await specs.store(message.specKey, validSpec() as never);
    const out = await worker.handle(message, { remainingMs: () => 1000 });
    expect(out).toMatchObject({ outcome: 'failed', reason: 'timeout' });
    expect(await results.get(out.resultKey!)).not.toBeNull();
  });

  it('lets unexpected errors propagate so the queue redelivers', async () => {
    const { specs, sent, worker } = setup(async () => {
      throw new Error('browser crashed');
    });
    await specs.store(message.specKey, validSpec() as never);
    await expect(
      worker.handle(message, { remainingMs: () => 1000 }),
    ).rejects.toThrow('browser crashed');
    expect(sent).toHaveLength(0);
  });

  it('does not import the database layer', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('./worker.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/from 'pg'|database\//);
  });
});
