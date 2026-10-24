import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { PointerActiveSpecResolver } from '../../src/scrape/api/active-spec.js';
import { InternalAuthGuard } from '../../src/scrape/api/internal-auth.guard.js';
import { InternalScrapeController } from '../../src/scrape/api/internal-scrape.controller.js';
import { RunsRepository } from '../../src/scrape/api/runs.repository.js';
import { ScrapeRequestService } from '../../src/scrape/api/scrape-request.service.js';
import {
  ACTIVE_SPEC_RESOLVER,
  SCRAPE_CONFIG,
  SCRAPE_QUEUE,
  SPEC_STORE,
} from '../../src/scrape/api/tokens.js';
import { validSpec } from '../../src/scrape/spec/spec-fixtures.js';
import { SpecStore } from '../../src/scrape/spec/spec-store.js';
import { activePointerKey, specKey } from '../../src/scrape/storage/keys.js';
import { InMemoryObjectStore } from '../../src/scrape/storage/object-store.js';
import { InMemoryScrapeQueue } from '../../src/scrape/testing/in-memory-queue.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';
import { createSite } from './support.js';

const TOKEN = 'internal-secret';
const auth = { Authorization: `Bearer ${TOKEN}` };

let db: TestDatabase;
let app: NestFastifyApplication;
let objects: InMemoryObjectStore;
let specs: SpecStore;
let queue: InMemoryScrapeQueue;
let runs: RunsRepository;

beforeAll(async () => {
  db = await createTestDatabase();
  objects = new InMemoryObjectStore();
  specs = new SpecStore(objects);
  queue = new InMemoryScrapeQueue();
  runs = new RunsRepository(db.pool);
  const moduleRef = await Test.createTestingModule({
    controllers: [InternalScrapeController],
    providers: [
      ScrapeRequestService,
      InternalAuthGuard,
      { provide: RunsRepository, useValue: runs },
      { provide: SPEC_STORE, useValue: specs },
      {
        provide: ACTIVE_SPEC_RESOLVER,
        useValue: new PointerActiveSpecResolver(objects),
      },
      { provide: SCRAPE_QUEUE, useValue: queue },
      {
        provide: SCRAPE_CONFIG,
        useValue: {
          internalApiToken: TOKEN,
          previewLimits: { maxPages: 2, maxItems: 20 },
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
  await db.close();
});

const http = () => request(app.getHttpServer() as App);

async function siteWithSpecs(
  name: string,
  versions: number[],
  active?: number,
) {
  const ctx = await createSite(db, name);
  for (const v of versions)
    await specs.store(
      specKey(ctx.customer.id, ctx.site.id, v),
      validSpec() as never,
    );
  if (active !== undefined)
    await objects.put(
      activePointerKey(ctx.customer.id, ctx.site.id),
      JSON.stringify({ version: active }),
    );
  return ctx;
}

describe('POST /internal/sites/:siteId/refresh', () => {
  it('records a run, enqueues one message and answers 202 with the run id', async () => {
    const { site } = await siteWithSpecs('Refresh', [1, 2], 2);
    const before = queue.sent.length;
    const res = await http()
      .post(`/internal/sites/${site.id}/refresh`)
      .set(auth)
      .expect(202);
    expect(res.body.runId).toEqual(expect.any(String));
    expect(queue.sent.length).toBe(before + 1);
    const sent = queue.sent[queue.sent.length - 1];
    expect(sent.message).toMatchObject({
      runId: res.body.runId,
      mode: 'production',
      siteId: site.id,
      specVersion: 2,
      schemaVersion: 1,
    });
    expect(sent.message.schema.variantProperty).toBe('size');
    expect(sent.groupId).toBe(site.id);
    expect(sent.deduplicationId).toBe(`${site.id}:production`);
  });

  it('answers 404 for an unknown site and enqueues nothing', async () => {
    const before = queue.sent.length;
    await http()
      .post('/internal/sites/7a2c1d52-1111-4a1a-8a0b-0e6c7f1b2a11/refresh')
      .set(auth)
      .expect(404);
    expect(queue.sent.length).toBe(before);
  });

  it('answers 409 no_active_spec without an active pointer', async () => {
    const { site } = await siteWithSpecs('NoActive', [1]);
    const before = queue.sent.length;
    const res = await http()
      .post(`/internal/sites/${site.id}/refresh`)
      .set(auth)
      .expect(409);
    expect(res.body.code).toBe('no_active_spec');
    expect(queue.sent.length).toBe(before);
  });

  it('rejects missing and wrong credentials without enqueuing', async () => {
    const { site } = await siteWithSpecs('Auth', [1], 1);
    const before = queue.sent.length;
    await http().post(`/internal/sites/${site.id}/refresh`).expect(401);
    await http()
      .post(`/internal/sites/${site.id}/refresh`)
      .set('Authorization', 'Bearer nope')
      .expect(403);
    await http()
      .post(`/internal/sites/${site.id}/preview`)
      .send({ specVersion: 1 })
      .expect(401);
    expect(queue.sent.length).toBe(before);
  });

  it('returns the existing run id for a duplicate request and does not enqueue again', async () => {
    const { site } = await siteWithSpecs('Dupe', [1], 1);
    const first = await http()
      .post(`/internal/sites/${site.id}/refresh`)
      .set(auth)
      .expect(202);
    const before = queue.sent.length;
    const second = await http()
      .post(`/internal/sites/${site.id}/refresh`)
      .set(auth)
      .expect(202);
    const third = await http()
      .post(`/internal/sites/${site.id}/refresh`)
      .set(auth)
      .expect(202);
    expect(second.body.runId).toBe(first.body.runId);
    expect(third.body.runId).toBe(first.body.runId);
    expect(queue.sent.length).toBe(before);
  });
});

describe('POST /internal/sites/:siteId/preview', () => {
  it('enqueues a limited preview of a candidate version and leaves the active spec alone', async () => {
    const { customer, site } = await siteWithSpecs('Preview', [1, 2], 1);
    const res = await http()
      .post(`/internal/sites/${site.id}/preview`)
      .set(auth)
      .send({ specVersion: 2 })
      .expect(202);
    const sent = queue.sent[queue.sent.length - 1];
    expect(sent.message).toMatchObject({
      runId: res.body.runId,
      mode: 'preview',
      specVersion: 2,
      limits: { maxPages: 2, maxItems: 20 },
    });
    expect(sent.deduplicationId).toBe(`${site.id}:preview:2`);
    const pointer = JSON.parse(
      (await objects.get(activePointerKey(customer.id, site.id)))!,
    );
    expect(pointer.version).toBe(1);
  });

  it('answers 404 for an unknown spec version and 400 for a bad body', async () => {
    const { site } = await siteWithSpecs('Unknown', [1], 1);
    const before = queue.sent.length;
    await http()
      .post(`/internal/sites/${site.id}/preview`)
      .set(auth)
      .send({ specVersion: 9 })
      .expect(404);
    await http()
      .post(`/internal/sites/${site.id}/preview`)
      .set(auth)
      .send({ specVersion: 'x' })
      .expect(400);
    expect(queue.sent.length).toBe(before);
  });

  it('dedupes per version, gives another version its own run, and allows a preview beside production', async () => {
    const { site } = await siteWithSpecs('Versions', [3, 4], 3);
    const preview = (v: number) =>
      http()
        .post(`/internal/sites/${site.id}/preview`)
        .set(auth)
        .send({ specVersion: v })
        .expect(202);
    const v3 = await preview(3);
    const before = queue.sent.length;
    expect((await preview(3)).body.runId).toBe(v3.body.runId);
    expect(queue.sent.length).toBe(before);

    const v4 = await preview(4);
    expect(v4.body.runId).not.toBe(v3.body.runId);
    expect(queue.sent.length).toBe(before + 1);

    const production = await http()
      .post(`/internal/sites/${site.id}/refresh`)
      .set(auth)
      .expect(202);
    expect(
      new Set([v3.body.runId, v4.body.runId, production.body.runId]).size,
    ).toBe(3);
  });
});

describe('enqueue failure', () => {
  it('fails the run it recorded so later requests are not blocked', async () => {
    const { customer, site } = await siteWithSpecs('Broken', [1], 1);
    const send = queue.send.bind(queue);
    queue.send = async () => {
      throw new Error('sqs down');
    };
    await http()
      .post(`/internal/sites/${site.id}/refresh`)
      .set(auth)
      .expect(500);
    queue.send = send;
    const retry = await http()
      .post(`/internal/sites/${site.id}/refresh`)
      .set(auth)
      .expect(202);
    expect((await runs.get(customer.id, retry.body.runId)).status).toBe(
      'queued',
    );
  });
});
