import { InternalAuthGuard } from '../../src/scrape/api/internal-auth.guard.js';
import { SCRAPE_CONFIG } from '../../src/scrape/api/tokens.js';
import { PointerActiveSpecResolver } from '../../src/scrape/api/active-spec.js';
import { AttemptsRepository } from '../../src/discovery/api/attempts.repository.js';
import { InternalDiscoveryController } from '../../src/discovery/api/internal-discovery.controller.js';
import { DiscoveryRequestService } from '../../src/discovery/api/discovery-request.service.js';
import { SpecVersionsRepository } from '../../src/discovery/api/spec-versions.repository.js';
import {
  AdmissionPolicy,
  allowAllAdmission,
  DiscoveryMessage,
  DiscoveryQueue,
} from '../../src/discovery/api/types.js';
import { validSpec } from '../../src/scrape/spec/spec-fixtures.js';
import { SpecStore } from '../../src/scrape/spec/spec-store.js';
import { activePointerKey, specKey } from '../../src/scrape/storage/keys.js';
import { InMemoryObjectStore } from '../../src/scrape/storage/object-store.js';
import { createSite } from '../scrape/support.js';
import { TestDatabase } from '../support/test-database.js';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

export const TOKEN = 'internal-secret';
export const auth = { Authorization: `Bearer ${TOKEN}` };

export class RecordingQueue implements DiscoveryQueue {
  readonly sent: DiscoveryMessage[] = [];
  fail = false;
  async send(message: DiscoveryMessage) {
    if (this.fail) throw new Error('sqs down');
    this.sent.push(message);
  }
}

/** Every `*.example` host resolves to a public address; `internal.example` does not. */
export const resolveHost = async (host: string) => {
  if (host === 'internal.example') return ['10.0.0.5'];
  if (host.endsWith('.example')) return ['93.184.216.34'];
  throw new Error('ENOTFOUND');
};

export async function buildDiscoveryApp(
  db: TestDatabase,
  options: { admission?: AdmissionPolicy } = {},
) {
  const objects = new InMemoryObjectStore();
  const specs = new SpecStore(objects);
  const queue = new RecordingQueue();
  const attempts = new AttemptsRepository(db.pool);
  const versions = new SpecVersionsRepository(db.pool);
  const active = new PointerActiveSpecResolver(objects);
  const service = new DiscoveryRequestService({
    attempts,
    versions,
    specs,
    active,
    queue,
    admission: options.admission ?? allowAllAdmission,
    caps: { maxTurns: 40, maxDurationMs: 600_000, maxCostUsd: 3 },
    resolveHost,
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [InternalDiscoveryController],
    providers: [
      InternalAuthGuard,
      { provide: DiscoveryRequestService, useValue: service },
      { provide: SCRAPE_CONFIG, useValue: { internalApiToken: TOKEN } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, objects, specs, queue, attempts, versions, service };
}

/** A site whose spec versions exist; `active` marks one of them live. */
export async function siteWithVersions(
  db: TestDatabase,
  objects: InMemoryObjectStore,
  specs: SpecStore,
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
