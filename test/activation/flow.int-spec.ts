import request from 'supertest';
import { App } from 'supertest/types.js';
import { seedPointersFromActiveJson } from '../../src/activation/seed-active-pointers.js';
import { DiscoveryFinalizer } from '../../src/discovery/api/discovery-finalizer.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';
import { getActive, setActive } from '../support/active.js';
import {
  buildActivationApp,
  candidateSpec,
  createSiteWith,
  headers,
} from './support.js';

let db: TestDatabase;
let h: Awaited<ReturnType<typeof buildActivationApp>>;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await buildActivationApp(db);
});
afterAll(async () => {
  await h.app.close();
  await db.close();
});

const http = () => request(h.app.getHttpServer() as App);
const post = (customerId: string, path: string, body: object = {}) =>
  http().post(path).set(headers(customerId)).send(body);
const get = (customerId: string, path: string) =>
  http().get(path).set(headers(customerId));
const put = (customerId: string, path: string, body: object = {}) =>
  http().put(path).set(headers(customerId)).send(body);

async function readySite(name: string, versions = 1) {
  const ctx = await createSiteWith(db, name);
  for (let v = 1; v <= versions; v++) {
    await h.addVersion(ctx.customer.id, ctx.site.id, v);
    await h.addPreview(ctx.site.id, v);
  }
  return ctx;
}
const activate = (
  c: { customer: { id: string }; site: { id: string } },
  body: object,
) => post(c.customer.id, `/internal/sites/${c.site.id}/activations`, body);
const productionRuns = async (siteId: string) =>
  (
    await db.pool.query(
      "SELECT spec_version, status FROM scrape_runs WHERE site_id = $1 AND mode = 'production'",
      [siteId],
    )
  ).rows;

describe('first activation: cadence, schedule and scrape (3.1)', () => {
  it('stores the cadence, creates the schedule and queues one production scrape for the version', async () => {
    const ctx = await readySite('FirstSched');
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: {
        expression: 'cron(0 8 * * ? *)',
        timezone: 'America/Argentina/Buenos_Aires',
      },
    }).expect(200);
    const { rows } = await db.pool.query(
      'SELECT expression, timezone FROM site_schedules WHERE site_id = $1',
      [ctx.site.id],
    );
    expect(rows[0]).toEqual({
      expression: 'cron(0 8 * * ? *)',
      timezone: 'America/Argentina/Buenos_Aires',
    });
    expect(h.schedules.schedules.get(ctx.site.id)).toEqual(rows[0]);
    expect(await productionRuns(ctx.site.id)).toEqual([
      { spec_version: 1, status: 'queued' },
    ]);
    expect(h.scrapeQueue.sent.at(-1)!.message).toMatchObject({
      siteId: ctx.site.id,
      mode: 'production',
      specVersion: 1,
    });
  });

  it.each([
    ['missing', undefined, 'cadence_required'],
    ['invalid', { expression: 'sometimes' }, 'invalid_cadence'],
    ['too frequent', { expression: 'rate(5 minutes)' }, 'invalid_cadence'],
    [
      'bad timezone',
      { expression: 'rate(1 day)', timezone: 'Mars/Base' },
      'invalid_cadence',
    ],
  ])(
    'rejects a %s cadence with 422 and changes nothing',
    async (_n, cadence, code) => {
      const ctx = await readySite(`Cad${code}${_n.replace(/\s/g, '')}`);
      const res = await activate(ctx, {
        version: 1,
        expectedCurrent: null,
        ...(cadence ? { cadence } : {}),
      }).expect(422);
      expect(res.body.code).toBe(code);
      expect(await getActive(db.pool, ctx.site.id)).toBeNull();
      expect(h.schedules.schedules.has(ctx.site.id)).toBe(false);
      expect(await productionRuns(ctx.site.id)).toEqual([]);
    },
  );

  it('leaves the schedule and runs alone on replacement activations and repeats', async () => {
    const ctx = await readySite('Replace', 2);
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: { expression: 'rate(1 day)' },
    }).expect(200);
    const calls = h.schedules.calls.length;
    const queued = h.scrapeQueue.sent.length;
    await activate(ctx, {
      version: 2,
      expectedCurrent: 1,
      cadence: { expression: 'rate(2 hours)' },
    }).expect(200);
    await activate(ctx, { version: 1, expectedCurrent: 2 }).expect(200);
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: { expression: 'rate(1 day)' },
    }).expect(200); // repeat
    expect(h.schedules.calls.length).toBe(calls);
    expect(h.scrapeQueue.sent.length).toBe(queued);
    expect(
      (
        await db.pool.query(
          'SELECT expression FROM site_schedules WHERE site_id = $1',
          [ctx.site.id],
        )
      ).rows[0].expression,
    ).toBe('rate(1 day)');
    expect(await productionRuns(ctx.site.id)).toHaveLength(1);
  });
});

describe('schedule reconciliation (3.2)', () => {
  it('repairs a schedule that could not be created during activation, from the stored cadence', async () => {
    const ctx = await readySite('Repair');
    h.schedules.fail = true;
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: { expression: 'rate(6 hours)' },
    }).expect(200); // the activation stands
    h.schedules.fail = false;
    expect(h.schedules.schedules.has(ctx.site.id)).toBe(false);
    expect(
      (
        await db.pool.query('SELECT 1 FROM site_schedules WHERE site_id = $1', [
          ctx.site.id,
        ])
      ).rowCount,
    ).toBe(1);

    await h.scheduleService.reconcile();
    expect(h.schedules.schedules.get(ctx.site.id)).toEqual({
      expression: 'rate(6 hours)',
      timezone: 'UTC',
    });
  });

  it('removes schedules of sites without an active version and corrects drifted ones', async () => {
    const live = await readySite('Drift');
    await activate(live, {
      version: 1,
      expectedCurrent: null,
      cadence: { expression: 'rate(1 day)' },
    }).expect(200);
    h.schedules.schedules.set(live.site.id, {
      expression: 'rate(5 minutes)',
      timezone: 'UTC',
    }); // drifted
    h.schedules.schedules.set('11111111-1111-4111-8111-111111111111', {
      expression: 'rate(1 day)',
      timezone: 'UTC',
    }); // orphan
    const result = await h.scheduleService.reconcile();
    expect(h.schedules.schedules.get(live.site.id)!.expression).toBe(
      'rate(1 day)',
    );
    expect(
      h.schedules.schedules.has('11111111-1111-4111-8111-111111111111'),
    ).toBe(false);
    expect(result.removed).toBeGreaterThanOrEqual(1);
  });
});

describe('schedule endpoints (3.3)', () => {
  it("changes only this site's cadence and schedule, requests no scrape, and leaves a running run alone", async () => {
    const a = await readySite('SchedA');
    const b = await readySite('SchedB');
    for (const c of [a, b])
      await activate(c, {
        version: 1,
        expectedCurrent: null,
        cadence: { expression: 'rate(1 day)' },
      }).expect(200);
    await db.pool.query(
      "UPDATE scrape_runs SET status = 'running' WHERE site_id = $1 AND mode = 'production'",
      [a.site.id],
    );
    const queued = h.scrapeQueue.sent.length;

    const res = await put(
      a.customer.id,
      `/internal/sites/${a.site.id}/schedule`,
      { expression: 'rate(6 hours)' },
    ).expect(200);
    expect(res.body).toEqual({ expression: 'rate(6 hours)', timezone: 'UTC' });
    expect(h.schedules.schedules.get(a.site.id)!.expression).toBe(
      'rate(6 hours)',
    );
    expect(h.schedules.schedules.get(b.site.id)!.expression).toBe(
      'rate(1 day)',
    );
    expect(h.scrapeQueue.sent.length).toBe(queued);
    expect((await productionRuns(a.site.id))[0].status).toBe('running');
    expect(
      (
        await get(
          a.customer.id,
          `/internal/sites/${a.site.id}/schedule`,
        ).expect(200)
      ).body.expression,
    ).toBe('rate(6 hours)');
  });

  it('answers 422 for too-frequent and invalid cadences, 409 without an active version, 404 for another customer', async () => {
    const a = await readySite('SchedErr');
    await put(a.customer.id, `/internal/sites/${a.site.id}/schedule`, {
      expression: 'rate(1 day)',
    })
      .expect(409)
      .then((r) => expect(r.body.code).toBe('no_active_spec'));
    await activate(a, {
      version: 1,
      expectedCurrent: null,
      cadence: { expression: 'rate(1 day)' },
    }).expect(200);
    await put(a.customer.id, `/internal/sites/${a.site.id}/schedule`, {
      expression: 'rate(5 minutes)',
    }).expect(422);
    await put(a.customer.id, `/internal/sites/${a.site.id}/schedule`, {
      expression: 'whenever',
    }).expect(422);
    const stranger = await createSiteWith(db, 'SchedStranger');
    await put(stranger.customer.id, `/internal/sites/${a.site.id}/schedule`, {
      expression: 'rate(3 hours)',
    }).expect(404);
    await get(
      stranger.customer.id,
      `/internal/sites/${a.site.id}/schedule`,
    ).expect(404);
    expect(h.schedules.schedules.get(a.site.id)!.expression).toBe(
      'rate(1 day)',
    );
  });
});

describe('preview on stored version and review (4.1, 4.2)', () => {
  it('creates exactly one preview when discovery stores a version; a failed one can be requested again', async () => {
    const ctx = await createSiteWith(db, 'Hook');
    const finalizer = new DiscoveryFinalizer({
      pool: db.pool,
      attempts: h.attempts,
      specs: h.specs,
      objects: h.objects,
      onVersionStored: ({ siteId, version }) =>
        h.scrapes
          .request({ mode: 'preview', siteId, specVersion: version })
          .then(() => undefined),
    });
    const stored = async () => {
      const { attemptId } = await h.discoveries.request({
        siteId: ctx.site.id,
        mode: 'full',
      });
      const key = `cand/${attemptId}.json`;
      await h.objects.put(key, JSON.stringify(candidateSpec()));
      await finalizer.handle({
        attemptId,
        outcome: 'candidate',
        candidateKey: key,
      });
    };
    await stored();
    const previews = () =>
      db.pool
        .query(
          "SELECT id, spec_version, status FROM scrape_runs WHERE site_id = $1 AND mode = 'preview' ORDER BY requested_at",
          [ctx.site.id],
        )
        .then((r) => r.rows);
    expect(await previews()).toMatchObject([
      { spec_version: 1, status: 'queued' },
    ]);

    // version 2 is stored while version 1's preview is still queued: its own preview, never version 1's
    await stored();
    const both = await previews();
    expect(both.map((r) => r.spec_version)).toEqual([1, 2]);
    expect(new Set(both.map((r) => r.id)).size).toBe(2);

    // repeated requests for the same version collapse; a failed preview can be requested again
    await post(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/2/previews`,
    ).expect(202);
    expect(await previews()).toHaveLength(2);
    await db.pool.query(
      "UPDATE scrape_runs SET status = 'failed', reason = 'timeout' WHERE id = $1",
      [both[1].id],
    );
    await post(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/2/previews`,
    ).expect(202);
    expect(await previews()).toHaveLength(3);
    await post(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/9/previews`,
    ).expect(404);
  });

  it('assembles the review for none, pending, failed, succeeded and expired previews', async () => {
    const ctx = await createSiteWith(db, 'Review', [
      { name: 'fabric', type: 'string', description: 'Fabric', required: true },
    ]);
    await h.addVersion(ctx.customer.id, ctx.site.id, 1);
    const review = () =>
      get(
        ctx.customer.id,
        `/internal/sites/${ctx.site.id}/spec-versions/1/review`,
      )
        .expect(200)
        .then((r) => r.body);

    expect((await review()).preview.status).toBe('none');
    expect((await review()).readyToActivate).toBe(false);

    await h.addPreview(ctx.site.id, 1, 'queued');
    expect((await review()).preview.status).toBe('pending');
    await db.pool.query(
      "UPDATE scrape_runs SET status = 'failed', reason = 'invalid_spec' WHERE site_id = $1",
      [ctx.site.id],
    );
    expect(await review()).toMatchObject({
      preview: { status: 'failed', reason: 'invalid_spec' },
      readyToActivate: false,
    });

    const runId = await h.addPreview(ctx.site.id, 1, 'succeeded', 4);
    const ready = await review();
    expect(ready).toMatchObject({
      version: {
        version: 1,
        mode: 'full',
        boundProperties: ['gender', 'type'],
        discarded: false,
      },
      preview: { status: 'succeeded', runId, expired: false },
      activeVersion: null,
      readyToActivate: true,
    });
    expect(ready.preview.sample).toHaveLength(4);
    expect(ready.preview.sample[0]).toMatchObject({
      raw: { gender: 'Nena' },
      value: { gender: 'girls' },
    });
    expect(ready.unboundProperties).toEqual([
      { name: 'fabric', required: true },
    ]);
    expect(ready.evidence).toMatchObject({ outcome: 'candidate' });

    h.objects.objects.delete(ready.preview.resultKey); // the stored sample aged out
    expect(await review()).toMatchObject({
      preview: { status: 'succeeded', expired: true, sample: [] },
      readyToActivate: true,
    });

    const stranger = await createSiteWith(db, 'ReviewStranger');
    await get(
      stranger.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/1/review`,
    ).expect(404);
  });
});

describe('retry from a review (4.3)', () => {
  it('queues a new attempt with new guidance and leaves the reviewed version and schema alone', async () => {
    const ctx = await readySite('Retry');
    const before = (
      await db.pool.query(
        'SELECT properties FROM catalog_schema_versions WHERE catalog_id = $1',
        [ctx.catalog.id],
      )
    ).rows;
    const res = await post(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/1/retry`,
      { guidance: 'the fabric is under the title' },
    ).expect(202);
    expect(h.discoveryQueue.sent.at(-1)).toMatchObject({
      attemptId: res.body.attemptId,
      mode: 'full',
      guidance: 'the fabric is under the title',
    });
    expect(
      (
        await get(
          ctx.customer.id,
          `/internal/sites/${ctx.site.id}/spec-versions/1/review`,
        ).expect(200)
      ).body.version.version,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          'SELECT properties FROM catalog_schema_versions WHERE catalog_id = $1',
          [ctx.catalog.id],
        )
      ).rows,
    ).toEqual(before);
  });

  it('extends the reviewed candidate when retried incrementally', async () => {
    const ctx = await createSiteWith(db, 'RetryInc', [
      { name: 'fabric', type: 'string', description: 'Fabric' },
    ]);
    await h.addVersion(ctx.customer.id, ctx.site.id, 1);
    await h.addVersion(ctx.customer.id, ctx.site.id, 2, {
      properties: ['gender'],
    }); // the newest, but not the one reviewed
    await setActive(db.pool, ctx.site.id, 2);
    const res = await post(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/1/retry`,
      { mode: 'incremental', guidance: 'look for fabric' },
    ).expect(202);
    const message = h.discoveryQueue.sent.at(-1)!;
    expect(message).toMatchObject({
      attemptId: res.body.attemptId,
      mode: 'incremental',
      baseVersion: 1,
      targetProperties: ['fabric'],
    });
    expect(message.baseSpecKey).toBe(
      `customers/${ctx.customer.id}/sites/${ctx.site.id}/specs/1.json`,
    );
  });

  it('answers 404 for another customer and 400 for a bad mode', async () => {
    const ctx = await readySite('RetryErr');
    const stranger = await createSiteWith(db, 'RetryStranger');
    await post(
      stranger.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/1/retry`,
      { guidance: 'x' },
    ).expect(404);
    await post(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/1/retry`,
      { mode: 'repair' },
    ).expect(400);
  });
});

describe('seeding pointers from the legacy active.json (5.1)', () => {
  it('creates pointer rows once and leaves existing ones alone', async () => {
    const ctx = await readySite('Legacy');
    const other = await readySite('LegacyOther');
    await h.objects.put(
      `customers/${ctx.customer.id}/sites/${ctx.site.id}/specs/active.json`,
      '{"version":1}',
    );
    await h.objects.put(
      `customers/${other.customer.id}/sites/${other.site.id}/specs/active.json`,
      '{"version":3}',
    );
    await setActive(db.pool, other.site.id, 1); // already activated through the new path
    const first = await seedPointersFromActiveJson(db.pool, h.objects);
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(await getActive(db.pool, ctx.site.id)).toBe(1);
    expect(await getActive(db.pool, other.site.id)).toBe(1); // not overwritten
    expect((await seedPointersFromActiveJson(db.pool, h.objects)).created).toBe(
      0,
    );
  });
});
