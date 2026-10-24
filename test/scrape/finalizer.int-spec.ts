import { RunFinalizer } from '../../src/scrape/api/run-finalizer.js';
import { RunsRepository } from '../../src/scrape/api/runs.repository.js';
import {
  FailedScrapeEvent,
  FinishedMessage,
  ResultItem,
  RunResult,
  ScrapeMessage,
} from '../../src/scrape/contracts/messages.js';
import { RawItem } from '../../src/scrape/runner/extract.js';
import { SpecStore } from '../../src/scrape/spec/spec-store.js';
import { validSpec } from '../../src/scrape/spec/spec-fixtures.js';
import { InMemoryObjectStore } from '../../src/scrape/storage/object-store.js';
import { InMemoryScrapeQueue } from '../../src/scrape/testing/in-memory-queue.js';
import { ScrapeWorker } from '../../src/scrape/worker/worker.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';
import { createSite } from './support.js';

let db: TestDatabase;
let runs: RunsRepository;

beforeAll(async () => {
  db = await createTestDatabase();
  runs = new RunsRepository(db.pool);
});
afterAll(async () => {
  await db.close();
});

const item = (n: number, launch: string | null = '2026-10-15'): ResultItem => ({
  raw: {
    name: `Remera ${n}`,
    link: `https://s/p/${n}`,
    launch: launch === null ? null : '15/10/2026',
  },
  value: {
    name: `Remera ${n}`,
    link: `https://s/p/${n}`,
    ...(launch ? { launch } : {}),
  },
  issues: [],
});

function harness() {
  const results = new InMemoryObjectStore();
  const reconciled: unknown[] = [];
  const failures: FailedScrapeEvent[] = [];
  const finalizer = new RunFinalizer({
    runs,
    results,
    reconciler: { reconcile: async (input) => void reconciled.push(input) },
    failures: { publish: async (e) => void failures.push(e) },
  });
  return { results, reconciled, failures, finalizer };
}

async function startRun(
  customerId: string,
  siteId: string,
  mode: 'production' | 'preview' = 'production',
  schemaVersion = 1,
) {
  const { run } = await runs.createOrGetPending(customerId, {
    siteId,
    mode,
    specVersion: 1,
    schemaVersion,
  });
  return run;
}

async function succeed(
  h: ReturnType<typeof harness>,
  runId: string,
  items: ResultItem[],
) {
  const resultKey = `results/${runId}.json`;
  const result: RunResult = {
    runId,
    siteId: 's',
    specVersion: 1,
    schemaVersion: 1,
    mode: 'production',
    finished: true,
    pages: 1,
    skipped: 0,
    items,
  };
  await h.results.put(resultKey, JSON.stringify(result));
  await h.finalizer.handle({
    runId,
    outcome: 'succeeded',
    resultKey,
    stats: { items: items.length, pages: 1, durationMs: 5 },
  } satisfies FinishedMessage);
}

describe('RunFinalizer', () => {
  it('reconciles a complete first run, passing typed values only', async () => {
    const { customer, site } = await createSite(db, 'First');
    const h = harness();
    const run = await startRun(customer.id, site.id);
    await h.finalizer.handle({ runId: run.id, outcome: 'started' });
    expect((await runs.get(customer.id, run.id)).status).toBe('running');

    await succeed(h, run.id, [item(1), item(2)]);

    expect(await runs.get(customer.id, run.id)).toMatchObject({
      status: 'succeeded',
      itemCount: 2,
    });
    expect(h.reconciled).toHaveLength(1);
    const input = h.reconciled[0] as {
      items: { value: Record<string, unknown>; raw?: unknown }[];
    };
    expect(input.items[0].value.launch).toBe('2026-10-15');
    expect(JSON.stringify(input)).not.toContain('15/10/2026');
    expect(h.failures).toEqual([]);
  });

  it('fails count_anomaly against the previous complete run and deletes nothing', async () => {
    const { customer, site } = await createSite(db, 'Count');
    const h = harness();
    const first = await startRun(customer.id, site.id);
    await succeed(
      h,
      first.id,
      Array.from({ length: 10 }, (_, i) => item(i)),
    );
    h.reconciled.length = 0;

    const second = await startRun(customer.id, site.id);
    await succeed(h, second.id, [item(1), item(2)]); // 80% fewer

    expect(await runs.get(customer.id, second.id)).toMatchObject({
      status: 'failed',
      reason: 'count_anomaly',
    });
    expect(h.reconciled).toHaveLength(0);
    expect(h.failures).toMatchObject([
      { reason: 'count_anomaly', siteId: site.id },
    ]);
  });

  it('accepts a count within the allowed deviation', async () => {
    const { customer, site } = await createSite(db, 'Within');
    const h = harness();
    await succeed(
      h,
      (await startRun(customer.id, site.id)).id,
      Array.from({ length: 10 }, (_, i) => item(i)),
    );
    const second = await startRun(customer.id, site.id);
    await succeed(
      h,
      second.id,
      Array.from({ length: 9 }, (_, i) => item(i)),
    );
    expect((await runs.get(customer.id, second.id)).status).toBe('succeeded');
  });

  it('fails parse_anomaly when a property parses for too few present values', async () => {
    const { customer, site } = await createSite(db, 'Parse');
    const h = harness();
    const run = await startRun(customer.id, site.id);
    // 3 of 5 present values parsed: 60% against an 80% minimum
    const items = [item(1), item(2), item(3), item(4, ''), item(5, '')].map(
      (i, idx) => {
        if (idx >= 3) {
          i.raw.launch = 'proximamente';
          delete i.value.launch;
        }
        return i;
      },
    );
    await succeed(h, run.id, items);
    expect(await runs.get(customer.id, run.id)).toMatchObject({
      status: 'failed',
      reason: 'parse_anomaly',
    });
    expect(h.reconciled).toHaveLength(0);
  });

  it('ignores missing raw values when computing the parse rate', async () => {
    const { customer, site } = await createSite(db, 'Missing');
    const h = harness();
    const run = await startRun(customer.id, site.id);
    await succeed(h, run.id, [item(1), item(2, null), item(3, null)]);
    expect((await runs.get(customer.id, run.id)).status).toBe('succeeded');
  });

  it('fails stale_schema when the catalog moved on while the run was in progress', async () => {
    const { customer, catalog, site } = await createSite(db, 'Stale');
    const h = harness();
    const run = await startRun(customer.id, site.id, 'production', 1);
    // simulate a schema change by inserting version 2 and moving the pointer
    await db.pool.query(
      `INSERT INTO catalog_schema_versions (catalog_id, version, properties, variant_property, changes)
       SELECT catalog_id, 2, properties, variant_property, changes FROM catalog_schema_versions WHERE catalog_id = $1 AND version = 1`,
      [catalog.id],
    );
    await db.pool.query(
      'UPDATE catalogs SET schema_version = 2 WHERE id = $1',
      [catalog.id],
    );

    await succeed(h, run.id, [item(1)]);
    expect(await runs.get(customer.id, run.id)).toMatchObject({
      status: 'failed',
      reason: 'stale_schema',
    });
    expect(h.reconciled).toHaveLength(0);
    expect(h.failures[0].reason).toBe('stale_schema');
  });

  it('records a timeout without reconciling and publishes failed_scrape', async () => {
    const { customer, site } = await createSite(db, 'Timeout');
    const h = harness();
    const run = await startRun(customer.id, site.id);
    await h.finalizer.handle({
      runId: run.id,
      outcome: 'failed',
      reason: 'timeout',
      detail: 'limit',
    });
    expect(await runs.get(customer.id, run.id)).toMatchObject({
      status: 'failed',
      reason: 'timeout',
    });
    expect(h.reconciled).toHaveLength(0);
    expect(h.failures).toMatchObject([{ reason: 'timeout' }]);
  });

  it('completes a preview without reconciling or publishing, and a failed preview publishes nothing', async () => {
    const { customer, site } = await createSite(db, 'Preview');
    const h = harness();
    const ok = await startRun(customer.id, site.id, 'preview');
    await succeed(h, ok.id, [item(1)]);
    expect(await runs.get(customer.id, ok.id)).toMatchObject({
      status: 'succeeded',
      resultKey: `results/${ok.id}.json`,
    });

    const bad = await runs.createOrGetPending(customer.id, {
      siteId: site.id,
      mode: 'preview',
      specVersion: 2,
      schemaVersion: 1,
    });
    await h.finalizer.handle({
      runId: bad.run.id,
      outcome: 'failed',
      reason: 'invalid_spec',
    });
    expect(await runs.get(customer.id, bad.run.id)).toMatchObject({
      status: 'failed',
      reason: 'invalid_spec',
    });
    expect(h.reconciled).toHaveLength(0);
    expect(h.failures).toEqual([]);
  });

  it('ignores a redelivered result for a run that already finished', async () => {
    const { customer, site } = await createSite(db, 'Again');
    const h = harness();
    const run = await startRun(customer.id, site.id);
    await succeed(h, run.id, [item(1)]);
    await succeed(h, run.id, [item(1)]);
    expect(h.reconciled).toHaveLength(1);
  });
});

describe('retries and the dead-letter queue', () => {
  const rawItem = (n: number): RawItem => ({
    system: {
      name: `R${n}`,
      link: `https://s/p/${n}`,
      price: '$ 1',
      thumbnail_url: null,
    },
    properties: { launch: '15/10/2026' },
    variants: [],
  });

  async function wire(
    execute: () => Promise<
      { finished: boolean; pages: number; rawItems: RawItem[] }
    >,
  ) {
    const { customer, catalog, site } = await createSite(
      db,
      `Retry${Math.random().toString(36).slice(2, 6)}`,
    );
    const h = harness();
    const objects = new InMemoryObjectStore();
    const specs = new SpecStore(objects);
    const message: ScrapeMessage = {
      runId: '',
      mode: 'production',
      customerId: customer.id,
      catalogId: catalog.id,
      siteId: site.id,
      specKey: 'specs/1.json',
      specVersion: 1,
      schemaVersion: 1,
      schema: { properties: ['launch'], variantProperty: null },
    };
    await specs.store(message.specKey, validSpec() as never);
    const worker = new ScrapeWorker({
      specs,
      results: h.results,
      publisher: { send: (m) => h.finalizer.handle(m) },
      execute: execute as never,
      safetyMarginMs: 0,
    });
    const run = await startRun(customer.id, site.id);
    message.runId = run.id;
    const queue = new InMemoryScrapeQueue(3);
    await queue.send(message, {
      groupId: site.id,
      deduplicationId: `${site.id}:production`,
    });
    return { h, worker, queue, customer, run, message };
  }

  it('retries a transient failure and reconciles the retried result without a dead letter', async () => {
    let attempts = 0;
    const ctx = await wire(async () => {
      if (++attempts === 1) throw new Error('browser crashed');
      return { finished: true, pages: 1, rawItems: [rawItem(1)] };
    });
    const handle = (m: ScrapeMessage) =>
      ctx.worker.handle(m, { remainingMs: () => 60_000 }).then(() => undefined);
    expect(await ctx.queue.deliverNext(handle)).toBe('redelivery');
    expect(await ctx.queue.deliverNext(handle)).toBe('acked');
    expect(ctx.queue.deadLetters).toHaveLength(0);
    expect(ctx.h.reconciled).toHaveLength(1);
    expect((await runs.get(ctx.customer.id, ctx.run.id)).status).toBe(
      'succeeded',
    );
  });

  it('moves a request that fails transiently three times to the dead-letter queue and fails the run', async () => {
    const ctx = await wire(async () => {
      throw new Error('network down');
    });
    const handle = (m: ScrapeMessage) =>
      ctx.worker.handle(m, { remainingMs: () => 60_000 }).then(() => undefined);
    expect(await ctx.queue.deliverNext(handle)).toBe('redelivery');
    expect(await ctx.queue.deliverNext(handle)).toBe('redelivery');
    expect(await ctx.queue.deliverNext(handle)).toBe('dead-lettered');
    expect(await ctx.queue.deliverNext(handle)).toBe('empty');
    await ctx.h.finalizer.handleDeadLetter(ctx.queue.deadLetters[0].message);
    expect(await runs.get(ctx.customer.id, ctx.run.id)).toMatchObject({
      status: 'failed',
      reason: 'error',
    });
    expect(ctx.h.failures).toMatchObject([{ reason: 'error' }]);
  });

  it('does not retry a deterministic failure', async () => {
    const ctx = await wire(async () => ({
      finished: false,
      pages: 1,
      rawItems: [rawItem(1)],
    }));
    const handle = (m: ScrapeMessage) =>
      ctx.worker.handle(m, { remainingMs: () => 60_000 }).then(() => undefined);
    expect(await ctx.queue.deliverNext(handle)).toBe('acked'); // timeout is reported, not retried
    expect(await runs.get(ctx.customer.id, ctx.run.id)).toMatchObject({
      status: 'failed',
      reason: 'timeout',
    });
    expect(ctx.h.reconciled).toHaveLength(0);
  });
});
