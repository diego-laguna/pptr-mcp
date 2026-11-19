import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import puppeteer from 'puppeteer-core';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { ProductsRepository } from '../../src/catalog/products.repository.js';
import { DbActiveSpecResolver } from '../../src/activation/db-active-spec.js';
import { setActive } from '../support/active.js';
import { InternalAuthGuard } from '../../src/scrape/api/internal-auth.guard.js';
import { InternalScrapeController } from '../../src/scrape/api/internal-scrape.controller.js';
import { RunFinalizer } from '../../src/scrape/api/run-finalizer.js';
import { RunsRepository } from '../../src/scrape/api/runs.repository.js';
import { ScrapeRequestService } from '../../src/scrape/api/scrape-request.service.js';
import {
  ACTIVE_SPEC_RESOLVER,
  SCRAPE_CONFIG,
  SCRAPE_QUEUE,
  SPEC_STORE,
} from '../../src/scrape/api/tokens.js';
import {
  FailedScrapeEvent,
  RunResult,
} from '../../src/scrape/contracts/messages.js';
import {
  FixtureServer,
  productCard,
  startFixtureServer,
} from '../../src/scrape/runner/fixture-server.js';
import { runWithBrowser } from '../../src/scrape/runner/runner.js';
import { validateSelectorSpec } from '../../src/scrape/spec/spec-validator.js';
import { SpecStore } from '../../src/scrape/spec/spec-store.js';
import { specKey } from '../../src/scrape/storage/keys.js';
import { InMemoryObjectStore } from '../../src/scrape/storage/object-store.js';
import { InMemoryScrapeQueue } from '../../src/scrape/testing/in-memory-queue.js';
import { ScrapeWorker } from '../../src/scrape/worker/worker.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';
import { createSite } from './support.js';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const TOKEN = 'secret';
const auth = { Authorization: `Bearer ${TOKEN}` };
const text = (css: string) => ({ locator: { css }, source: 'text' as const });

describe.skipIf(!existsSync(chrome))(
  'scrape end to end (real Chrome, local fakes for AWS)',
  () => {
    let db: TestDatabase;
    let app: NestFastifyApplication;
    let fixtures: FixtureServer;
    let hang: ReturnType<typeof createServer>;
    let hangPort: number;
    let objects: InMemoryObjectStore;
    let specs: SpecStore;
    let queue: InMemoryScrapeQueue;
    let runs: RunsRepository;
    let products: ProductsRepository;
    let finalizer: RunFinalizer;
    let worker: ScrapeWorker;
    const reconciled: unknown[] = [];
    const failures: FailedScrapeEvent[] = [];
    let workerBudgetMs = 60_000;

    beforeAll(async () => {
      db = await createTestDatabase();
      objects = new InMemoryObjectStore();
      specs = new SpecStore(objects);
      queue = new InMemoryScrapeQueue();
      runs = new RunsRepository(db.pool);
      products = new ProductsRepository(db.pool);
      fixtures = await startFixtureServer({
        '/shop': `<html><body>${[1, 2, 3]
          .map((n) =>
            productCard(
              n,
              `<span class="gender">${n === 2 ? 'Nene' : 'Nena'}</span><span class="type">Remera</span>
             <ul><li><b>4</b><i>$ ${n}.000,00</i></li><li><b>6</b><i>$ ${n}.500,00</i></li></ul>`,
            ),
          )
          .join('')}</body></html>`,
      });
      hang = createServer(() => undefined); // accepts connections, never answers
      await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
      hangPort = (hang.address() as { port: number }).port;

      finalizer = new RunFinalizer({
        runs,
        results: objects,
        reconciler: { reconcile: async (i) => void reconciled.push(i) },
        failures: { publish: async (e) => void failures.push(e) },
      });
      worker = new ScrapeWorker({
        specs,
        results: objects,
        publisher: { send: (m) => finalizer.handle(m) },
        execute: (spec, options) =>
          runWithBrowser(
            {
              launch: () =>
                puppeteer.launch({
                  executablePath: chrome,
                  headless: true,
                  args: ['--no-sandbox'],
                }),
            },
            spec,
            options,
          ),
        safetyMarginMs: 300,
      });

      const moduleRef = await Test.createTestingModule({
        controllers: [InternalScrapeController],
        providers: [
          ScrapeRequestService,
          InternalAuthGuard,
          { provide: RunsRepository, useValue: runs },
          { provide: SPEC_STORE, useValue: specs },
          {
            provide: ACTIVE_SPEC_RESOLVER,
            useValue: new DbActiveSpecResolver(db.pool),
          },
          { provide: SCRAPE_QUEUE, useValue: queue },
          {
            provide: SCRAPE_CONFIG,
            useValue: {
              internalApiToken: TOKEN,
              previewLimits: { maxPages: 1, maxItems: 2 },
            },
          },
        ],
      }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      await app.close();
      await fixtures.close();
      hang.closeAllConnections();
      await new Promise((r) => hang.close(r));
      await db.close();
    });

    const http = () => request(app.getHttpServer() as App);

    const specFor = (url: string) =>
      validateSelectorSpec({
        formatVersion: 1,
        site: { url: fixtures.origin },
        steps: [{ type: 'open_url', url }],
        items: { locator: { css: '.product' } },
        system: {
          name: text('.name'),
          link: { locator: { css: 'a' }, source: { attribute: 'href' } },
          price: text('.price'),
          thumbnail_url: {
            locator: { css: 'img' },
            source: { attribute: 'src' },
          },
        },
        properties: {
          gender: {
            ...text('.gender'),
            transforms: [
              { type: 'enum_map', map: { nena: 'girls', nene: 'boys' } },
            ],
          },
          type: text('.type'),
        },
        variants: {
          locator: { css: 'li' },
          value: text('b'),
          price: text('i'),
          available: { source: 'text' },
        },
      });

    // Delivers queued messages through the worker, as the Lambda event source would.
    async function drain() {
      for (;;) {
        const outcome = await queue.deliverNext((m) =>
          worker
            .handle(m, { remainingMs: () => workerBudgetMs })
            .then(() => undefined),
        );
        if (outcome === 'empty') return;
      }
    }

    async function setupSite(name: string, url: string) {
      const ctx = await createSite(db, name);
      await specs.store(
        specKey(ctx.customer.id, ctx.site.id, 1),
        specFor(url) as never,
      );
      await setActive(db.pool, ctx.site.id, 1);
      return ctx;
    }

    it('runs a refresh end to end and hands only typed values to reconciliation', async () => {
      const { customer, site } = await setupSite(
        'E2E',
        `${fixtures.origin}/shop`,
      );
      reconciled.length = 0;

      const { body } = await http()
        .post(`/internal/sites/${site.id}/refresh`)
        .set(auth)
        .expect(202);
      expect((await runs.get(customer.id, body.runId)).status).toBe('queued');
      await drain();

      const run = await runs.get(customer.id, body.runId);
      expect(run).toMatchObject({ status: 'succeeded', itemCount: 3 });

      const result = JSON.parse(
        (await objects.get(run.resultKey!))!,
      ) as RunResult;
      expect(result.items[0].raw.gender).toBe('Nena');
      expect(result.items[0].value.gender).toBe('girls');
      expect(result.items[0].variants).toHaveLength(2);

      expect(reconciled).toHaveLength(1);
      const input = reconciled[0] as {
        items: { value: Record<string, unknown> }[];
      };
      expect(input.items.map((i) => i.value.gender)).toEqual([
        'girls',
        'boys',
        'girls',
      ]);
      expect(JSON.stringify(input)).not.toContain('Nena');
    });

    it('fails a forced timeout, deletes nothing and publishes failed_scrape', async () => {
      const { customer, site } = await setupSite(
        'Slow',
        `http://127.0.0.1:${hangPort}/`,
      );
      await products.create(customer.id, site.id, 1, {
        name: 'Existing',
        link: 'https://shop.example/existing',
        attributes: {},
        variants: [{ value: '4', price: '$ 1', available: true }],
      });
      failures.length = 0;
      reconciled.length = 0;
      workerBudgetMs = 1500;

      const { body } = await http()
        .post(`/internal/sites/${site.id}/refresh`)
        .set(auth)
        .expect(202);
      await drain();
      workerBudgetMs = 60_000;

      expect(await runs.get(customer.id, body.runId)).toMatchObject({
        status: 'failed',
        reason: 'timeout',
      });
      expect(reconciled).toHaveLength(0);
      expect(failures).toMatchObject([{ reason: 'timeout', siteId: site.id }]);
      const { rows } = await db.pool.query(
        'SELECT count(*)::int AS n FROM products WHERE site_id = $1',
        [site.id],
      );
      expect(rows[0].n).toBe(1);
    });

    it('runs a preview within its limits and leaves the catalog and events untouched', async () => {
      const { customer, site } = await setupSite(
        'Preview',
        `${fixtures.origin}/shop`,
      );
      reconciled.length = 0;
      failures.length = 0;

      const { body } = await http()
        .post(`/internal/sites/${site.id}/preview`)
        .set(auth)
        .send({ specVersion: 1 })
        .expect(202);
      await drain();

      const run = await runs.get(customer.id, body.runId);
      expect(run).toMatchObject({
        status: 'succeeded',
        mode: 'preview',
        itemCount: 2,
      }); // maxItems 2
      const result = JSON.parse(
        (await objects.get(run.resultKey!))!,
      ) as RunResult;
      expect(result.items[0].raw.gender).toBe('Nena');
      expect(result.items[0].value.gender).toBe('girls');
      expect(reconciled).toHaveLength(0);
      expect(failures).toEqual([]);
      const { rows } = await db.pool.query(
        'SELECT count(*)::int AS n FROM products WHERE site_id = $1',
        [site.id],
      );
      expect(rows[0].n).toBe(0);
    });
  },
);
