import { DiscoveryFinalizer } from '../../src/discovery/api/discovery-finalizer.js';
import { NotFoundError } from '../../src/catalog/errors.js';
import { validSpec } from '../../src/scrape/spec/spec-fixtures.js';
import { SpecStore } from '../../src/scrape/spec/spec-store.js';
import { getActive, setActive } from '../support/active.js';
import { specKey } from '../../src/scrape/storage/keys.js';
import { createSite } from '../scrape/support.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';
import { buildDiscoveryApp } from './support.js';

let db: TestDatabase;
let h: Awaited<ReturnType<typeof buildDiscoveryApp>>;
let finalizer: DiscoveryFinalizer;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await buildDiscoveryApp(db);
  finalizer = new DiscoveryFinalizer({
    pool: db.pool,
    attempts: h.attempts,
    specs: h.specs,
    objects: h.objects,
  });
});
afterAll(async () => {
  await h.app.close();
  await db.close();
});

/** A candidate binding `launch`, which the clothing catalog does not declare unless added. */
async function declare(siteId: string, ...names: string[]) {
  const props = names.map((name) => ({
    name,
    type: 'string',
    description: name,
    required: false,
    filterable: false,
  }));
  await db.pool.query(
    `UPDATE catalog_schema_versions SET properties = properties || $2::jsonb
      WHERE catalog_id = (SELECT catalog_id FROM sites WHERE id = $1)`,
    [siteId, JSON.stringify(props)],
  );
}

async function newAttempt(siteId: string) {
  const { attemptId } = await h.service.request({ siteId, mode: 'full' });
  return attemptId;
}

async function offer(attemptId: string, candidate: object, extra: object = {}) {
  const key = `discoveries/x/${attemptId}/candidate.json`;
  await h.objects.put(key, JSON.stringify(candidate));
  await finalizer.handle({
    attemptId,
    outcome: 'candidate',
    candidateKey: key,
    evidenceKey: `ev/${attemptId}`,
    usage: { turns: 7, durationMs: 1000, costUsd: 0.4 },
    ...extra,
  });
}

describe('DiscoveryFinalizer', () => {
  it('stores the first candidate as version 1 and the next as version 2, leaving 1 unchanged', async () => {
    const { customer, site } = await createSite(db, 'Versions');
    await declare(site.id, 'launch');
    await offer(await newAttempt(site.id), validSpec());
    const changed = validSpec();
    changed.items.locator = { css: '.other' };
    const second = await newAttempt(site.id);
    await offer(second, changed);

    const list = await h.versions.list(customer.id, site.id);
    expect(list.map((v) => v.version)).toEqual([2, 1]); // newest first
    expect(list[0]).toMatchObject({
      source: 'discovery',
      mode: 'full',
      attemptId: second,
      schemaVersion: 1,
      boundProperties: ['launch'],
    });
    const v1 = await h.specs.load(specKey(customer.id, site.id, 1));
    expect(v1.items.locator).toEqual({ css: '.product' });
    expect(await h.attempts.get(customer.id, second)).toMatchObject({
      status: 'candidate_ready',
      specVersion: 2,
      evidenceKey: `ev/${second}`,
      usage: { turns: 7 },
    });
  });

  it('gives two simultaneous finalizations distinct consecutive numbers', async () => {
    // The one-pending-attempt index normally prevents two live attempts per site;
    // drop it in a scratch database to prove the numbering itself is race-free.
    const scratch = await createTestDatabase();
    const sh = await buildDiscoveryApp(scratch);
    await scratch.pool.query('DROP INDEX discovery_attempts_pending_key');
    const f = new DiscoveryFinalizer({
      pool: scratch.pool,
      attempts: sh.attempts,
      specs: sh.specs,
      objects: sh.objects,
    });
    const { customer, site } = await createSite(scratch, 'Race');
    await scratch.pool.query(
      `UPDATE catalog_schema_versions SET properties = properties || '[{"name":"launch","type":"string","description":"d","required":false,"filterable":false}]'::jsonb`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { rows } = await scratch.pool.query(
        `INSERT INTO discovery_attempts (site_id, mode, schema_version, schema_snapshot, status) VALUES ($1, 'full', 1, '{}', 'running') RETURNING id`,
        [site.id],
      );
      ids.push(rows[0].id);
    }
    await Promise.all(
      ids.map(async (attemptId, n) => {
        const c = validSpec();
        c.items.locator = { css: `.c${n}` };
        const key = `cand/${attemptId}.json`;
        await sh.objects.put(key, JSON.stringify(c));
        await f.handle({ attemptId, outcome: 'candidate', candidateKey: key });
      }),
    );
    expect(
      (await sh.versions.list(customer.id, site.id)).map((v) => v.version),
    ).toEqual([4, 3, 2, 1]);
    await sh.app.close();
    await scratch.close();
  });

  it('fails schema_changed and stores nothing when a bound property was removed', async () => {
    const { customer, site } = await createSite(db, 'Removed');
    const attemptId = await newAttempt(site.id);
    await offer(attemptId, validSpec()); // binds `launch`, which the catalog never declared
    expect(await h.attempts.get(customer.id, attemptId)).toMatchObject({
      status: 'failed',
      reason: 'schema_changed',
    });
    expect(await h.versions.list(customer.id, site.id)).toEqual([]);
    expect(await h.specs.exists(specKey(customer.id, site.id, 1))).toBe(false);
  });

  it('stores the candidate when a property was added meanwhile', async () => {
    const { customer, site } = await createSite(db, 'Added');
    await declare(site.id, 'launch');
    const attemptId = await newAttempt(site.id);
    await declare(site.id, 'fabric'); // added after the attempt began
    await offer(attemptId, validSpec());
    expect(await h.attempts.get(customer.id, attemptId)).toMatchObject({
      status: 'candidate_ready',
      specVersion: 1,
    });
  });

  it('records failures reported by the worker and an invalid candidate as invalid_output', async () => {
    const { customer, site } = await createSite(db, 'Failures');
    const attemptId = await newAttempt(site.id);
    await finalizer.handle({ attemptId, outcome: 'started' });
    expect((await h.attempts.get(customer.id, attemptId)).status).toBe(
      'running',
    );
    await finalizer.handle({
      attemptId,
      outcome: 'failed',
      reason: 'blocked_by_site',
      usage: { turns: 3, durationMs: 50 },
    });
    expect(await h.attempts.get(customer.id, attemptId)).toMatchObject({
      status: 'failed',
      reason: 'blocked_by_site',
      usage: { turns: 3 },
    });

    const bad = await newAttempt(site.id);
    await offer(bad, { formatVersion: 99 });
    expect(await h.attempts.get(customer.id, bad)).toMatchObject({
      status: 'failed',
      reason: 'invalid_output',
    });
  });

  it('fails an attempt that reached the dead-letter queue', async () => {
    const { customer, site } = await createSite(db, 'Dead');
    const attemptId = await newAttempt(site.id);
    await finalizer.handleDeadLetter(attemptId);
    expect(await h.attempts.get(customer.id, attemptId)).toMatchObject({
      status: 'failed',
      reason: 'error',
    });
  });
});

describe('version retrieval', () => {
  it("treats another customer's site and versions as not found", async () => {
    const owner = await createSite(db, 'OwnerA');
    const other = await createSite(db, 'OwnerB');
    await declare(owner.site.id, 'launch');
    await offer(await newAttempt(owner.site.id), validSpec());
    await expect(
      h.versions.list(other.customer.id, owner.site.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      h.versions.get(other.customer.id, owner.site.id, 1),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await h.versions.get(owner.customer.id, owner.site.id, 1)).version,
    ).toBe(1);
  });
});

describe('activation is not touched', () => {
  it('leaves version 2 active when version 3 is stored', async () => {
    const { customer, site } = await createSite(db, 'Active');
    await declare(site.id, 'launch');
    const store = new SpecStore(h.objects);
    void store;
    for (let i = 1; i <= 3; i++) {
      const c = validSpec();
      c.items.locator = { css: `.v${i}` };
      if (i === 3) {
        await setActive(db.pool, site.id, 2);
      }
      await offer(await newAttempt(site.id), c);
    }
    expect(
      (await h.versions.list(customer.id, site.id)).map((v) => v.version),
    ).toEqual([3, 2, 1]);
    expect(await getActive(db.pool, site.id)).toBe(2);
  });
});
