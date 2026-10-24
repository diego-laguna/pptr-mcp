import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ActivationService } from '../../src/activation/activation.service.js';
import { Cadence } from '../../src/activation/cadence.js';
import { DbActiveSpecResolver } from '../../src/activation/db-active-spec.js';
import { InternalActivationController } from '../../src/activation/internal-activation.controller.js';
import { ReviewService } from '../../src/activation/review.service.js';
import { SchedulePort } from '../../src/activation/schedule-port.js';
import { ScheduleService } from '../../src/activation/schedule.service.js';
import { CatalogsRepository } from '../../src/catalog/catalogs.repository.js';
import { CustomersRepository } from '../../src/catalog/customers.repository.js';
import { SitesRepository } from '../../src/catalog/sites.repository.js';
import { AttemptsRepository } from '../../src/discovery/api/attempts.repository.js';
import { DiscoveryRequestService } from '../../src/discovery/api/discovery-request.service.js';
import { SpecVersionsRepository } from '../../src/discovery/api/spec-versions.repository.js';
import { allowAllAdmission } from '../../src/discovery/api/types.js';
import { InternalAuthGuard } from '../../src/scrape/api/internal-auth.guard.js';
import { RunsRepository } from '../../src/scrape/api/runs.repository.js';
import { ScrapeRequestService } from '../../src/scrape/api/scrape-request.service.js';
import { SCRAPE_CONFIG } from '../../src/scrape/api/tokens.js';
import { SpecStore } from '../../src/scrape/spec/spec-store.js';
import { specKey } from '../../src/scrape/storage/keys.js';
import { InMemoryObjectStore } from '../../src/scrape/storage/object-store.js';
import { InMemoryScrapeQueue } from '../../src/scrape/testing/in-memory-queue.js';
import { TestDatabase } from '../support/test-database.js';
import { RecordingQueue, resolveHost } from '../discovery/support.js';

export const TOKEN = 'internal-secret';
export const headers = (customerId: string) => ({
  Authorization: `Bearer ${TOKEN}`,
  'X-Customer-Id': customerId,
});

export class FakeSchedules implements SchedulePort {
  readonly schedules = new Map<string, Cadence>();
  fail = false;
  readonly calls: string[] = [];
  async upsert(siteId: string, cadence: Cadence) {
    this.calls.push(`upsert:${siteId}`);
    if (this.fail) throw new Error('scheduler down');
    this.schedules.set(siteId, cadence);
  }
  async remove(siteId: string) {
    this.calls.push(`remove:${siteId}`);
    this.schedules.delete(siteId);
  }
  async listSiteIds() {
    return [...this.schedules.keys()];
  }
}

/** A catalog whose schema the tests control: `gender` and `type` are bound by the stored specs. */
export async function createSiteWith(
  db: TestDatabase,
  name: string,
  properties: Record<string, unknown>[] = [],
) {
  const customers = new CustomersRepository(db.pool);
  const catalogs = new CatalogsRepository(db.pool);
  const sites = new SitesRepository(db.pool);
  const customer = await customers.create(name);
  const catalog = await catalogs.create(customer.id, 'kids', {
    properties: [
      { name: 'gender', type: 'string', description: 'Audience' },
      { name: 'type', type: 'string', description: 'Garment type' },
      ...properties,
    ],
  } as never);
  const site = await sites.add(customer.id, catalog.id, {
    url: `https://${name.toLowerCase()}.example`,
    name: 'Shop',
    country: 'AR',
    currency: 'ARS',
  });
  return { customer, catalog, site };
}

const text = (css: string) => ({ locator: { css }, source: 'text' as const });

export function candidateSpec(properties: string[] = ['gender', 'type']) {
  return {
    formatVersion: 1,
    site: { url: 'https://shop.example' },
    steps: [{ type: 'open_url', url: 'https://shop.example/kids' }],
    items: { locator: { css: '.product' } },
    system: {
      name: text('.name'),
      link: { locator: { css: 'a' }, source: { attribute: 'href' } },
      price: text('.price'),
      thumbnail_url: { locator: { css: 'img' }, source: { attribute: 'src' } },
    },
    properties: Object.fromEntries(properties.map((p) => [p, text(`.${p}`)])),
  };
}

export async function buildActivationApp(db: TestDatabase) {
  const objects = new InMemoryObjectStore();
  const specs = new SpecStore(objects);
  const scrapeQueue = new InMemoryScrapeQueue();
  const discoveryQueue = new RecordingQueue();
  const schedules = new FakeSchedules();
  const runs = new RunsRepository(db.pool);
  const attempts = new AttemptsRepository(db.pool);
  const versions = new SpecVersionsRepository(db.pool);
  const active = new DbActiveSpecResolver(db.pool);
  const scrapes = new ScrapeRequestService(runs, specs, active, scrapeQueue, {
    previewLimits: { maxPages: 1, maxItems: 5 },
  });
  const discoveries = new DiscoveryRequestService({
    attempts,
    versions,
    specs,
    active,
    queue: discoveryQueue,
    admission: allowAllAdmission,
    caps: { maxTurns: 10, maxDurationMs: 60_000, maxCostUsd: 1 },
    resolveHost,
  });
  const activation = new ActivationService({
    pool: db.pool,
    specs,
    schedules,
    requestScrape: (siteId) => scrapes.request({ mode: 'production', siteId }),
    minIntervalMinutes: 60,
  });
  const scheduleService = new ScheduleService({ pool: db.pool, schedules });
  const review = new ReviewService({ pool: db.pool, objects, specs });

  const moduleRef = await Test.createTestingModule({
    controllers: [InternalActivationController],
    providers: [
      InternalAuthGuard,
      { provide: SCRAPE_CONFIG, useValue: { internalApiToken: TOKEN } },
      { provide: ActivationService, useValue: activation },
      { provide: ScheduleService, useValue: scheduleService },
      { provide: ReviewService, useValue: review },
      { provide: SpecVersionsRepository, useValue: versions },
      { provide: ScrapeRequestService, useValue: scrapes },
      { provide: DiscoveryRequestService, useValue: discoveries },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  /** A stored candidate version, as discovery would leave it. */
  async function addVersion(
    customerId: string,
    siteId: string,
    version: number,
    options: {
      properties?: string[];
      mode?: string;
      baseVersion?: number | null;
    } = {},
  ) {
    const properties = options.properties ?? ['gender', 'type'];
    const { rows } = await db.pool.query(
      `INSERT INTO discovery_attempts (site_id, mode, schema_version, schema_snapshot, status, spec_version, evidence_key, finished_at)
       VALUES ($1, $2, 1, '{}', 'candidate_ready', $3, $4, now()) RETURNING id`,
      [siteId, options.mode ?? 'full', version, `ev/${siteId}/${version}.json`],
    );
    await db.pool.query(
      `INSERT INTO site_spec_versions (site_id, version, mode, attempt_id, base_version, schema_version, bound_properties)
       VALUES ($1, $2, $3, $4, $5, 1, $6)`,
      [
        siteId,
        version,
        options.mode ?? 'full',
        rows[0].id,
        options.baseVersion ?? null,
        properties,
      ],
    );
    await specs.store(
      specKey(customerId, siteId, version),
      candidateSpec(properties) as never,
    );
    await objects.put(
      `ev/${siteId}/${version}.json`,
      JSON.stringify({ outcome: 'candidate', screenshots: [], unresolved: [] }),
    );
  }

  /** A preview run record for a version. */
  async function addPreview(
    siteId: string,
    version: number,
    status: 'succeeded' | 'failed' | 'queued' = 'succeeded',
    items = 3,
  ) {
    const resultKey = `runs/preview/${siteId}/${version}.json`;
    const { rows } = await db.pool.query(
      `INSERT INTO scrape_runs (site_id, mode, spec_version, schema_version, status, reason, result_key, item_count, finished_at)
       VALUES ($1, 'preview', $2, 1, $3, $4, $5, $6, CASE WHEN $3 IN ('succeeded','failed') THEN now() END) RETURNING id`,
      [
        siteId,
        version,
        status,
        status === 'failed' ? 'invalid_spec' : null,
        status === 'succeeded' ? resultKey : null,
        status === 'succeeded' ? items : null,
      ],
    );
    if (status === 'succeeded')
      await objects.put(
        resultKey,
        JSON.stringify({
          items: Array.from({ length: items }, (_, i) => ({
            raw: { name: `Item ${i}`, gender: 'Nena' },
            value: { name: `Item ${i}`, gender: 'girls' },
            issues: [],
          })),
        }),
      );
    return rows[0].id as string;
  }

  return {
    app,
    objects,
    specs,
    scrapeQueue,
    discoveryQueue,
    schedules,
    runs,
    attempts,
    versions,
    activation,
    scheduleService,
    review,
    scrapes,
    discoveries,
    addVersion,
    addPreview,
  };
}
