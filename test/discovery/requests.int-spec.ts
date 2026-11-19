import request from 'supertest';
import { App } from 'supertest/types.js';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';
import { createSite } from '../scrape/support.js';
import { AdmissionPolicy } from '../../src/discovery/api/types.js';
import { auth, buildDiscoveryApp, siteWithVersions } from './support.js';

let db: TestDatabase;
let h: Awaited<ReturnType<typeof buildDiscoveryApp>>;
let app: NestFastifyApplication;
let refusing = false;

const admission: AdmissionPolicy = {
  check: async () =>
    refusing ? { allowed: false, reason: 'quota' } : { allowed: true },
};

beforeAll(async () => {
  db = await createTestDatabase();
  h = await buildDiscoveryApp(db, { admission });
  app = h.app;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const http = () => request(app.getHttpServer() as App);
const post = (siteId: string, body: object = {}) =>
  http().post(`/internal/sites/${siteId}/discoveries`).set(auth).send(body);

describe('POST /internal/sites/:siteId/discoveries', () => {
  it('accepts a full discovery, records the attempt and enqueues it with the schema snapshot', async () => {
    const { customer, site } = await createSite(db, 'Full');
    const res = await post(site.id, {
      mode: 'full',
      guidance: 'prices are in ARS',
    }).expect(202);
    const attempt = await h.attempts.get(customer.id, res.body.attemptId);
    expect(attempt).toMatchObject({
      status: 'queued',
      mode: 'full',
      schemaVersion: 1,
      guidance: 'prices are in ARS',
    });
    const message = h.queue.sent.find(
      (m) => m.attemptId === res.body.attemptId,
    )!;
    expect(message.siteUrl).toBe(site.url);
    expect(message.snapshot.variantProperty).toBe('size');
    expect(message.snapshot.properties.map((p) => p.name)).toEqual([
      'gender',
      'type',
      'size',
      'unit_system',
    ]);
    expect(message.caps).toEqual({
      maxTurns: 40,
      maxDurationMs: 600_000,
      maxCostUsd: 3,
    });
    expect(message.outputPrefix).toBe(
      `discoveries/${customer.id}/${site.id}/${attempt.id}`,
    );
  });

  it('answers 404 for an unknown site and 422 for guidance over 2000 characters, creating nothing', async () => {
    const before = h.queue.sent.length;
    await post('7a2c1d52-1111-4a1a-8a0b-0e6c7f1b2a11').expect(404);
    const { site } = await createSite(db, 'Long');
    await post(site.id, { guidance: 'x'.repeat(2001) }).expect(422);
    await post(site.id, { mode: 'weird' }).expect(422);
    expect(h.queue.sent.length).toBe(before);
    expect(await h.attempts.findPending(site.id)).toBeNull();
  });

  it('rejects calls without the internal credential', async () => {
    const { site } = await createSite(db, 'Auth');
    await http()
      .post(`/internal/sites/${site.id}/discoveries`)
      .send({})
      .expect(401);
  });

  it('returns the existing attempt for a duplicate request without enqueuing again', async () => {
    const { site } = await createSite(db, 'Dupe');
    const first = await post(site.id).expect(202);
    const before = h.queue.sent.length;
    const second = await post(site.id).expect(202);
    expect(second.body.attemptId).toBe(first.body.attemptId);
    expect(h.queue.sent.length).toBe(before);
  });

  it('rejects a site whose URL resolves to an internal address with 422 and queues nothing', async () => {
    const { site } = await createSite(db, 'Internal');
    await db.pool.query(
      "UPDATE sites SET url = 'https://internal.example' WHERE id = $1",
      [site.id],
    );
    const before = h.queue.sent.length;
    await post(site.id).expect(422);
    await db.pool.query(
      "UPDATE sites SET url = 'http://169.254.169.254/' WHERE id = $1",
      [site.id],
    );
    await post(site.id).expect(422);
    await db.pool.query(
      "UPDATE sites SET url = 'ftp://shop.example/' WHERE id = $1",
      [site.id],
    );
    await post(site.id).expect(422);
    expect(h.queue.sent.length).toBe(before);
  });

  it('answers 429 budget_exhausted when the allowance refuses and 202 when none is configured', async () => {
    const { site } = await createSite(db, 'Budget');
    refusing = true;
    const res = await post(site.id).expect(429);
    expect(res.body.reason).toBe('budget_exhausted');
    expect(await h.attempts.findPending(site.id)).toBeNull();
    refusing = false;
    await post(site.id).expect(202);
  });

  it('fails the attempt it recorded when enqueueing fails, so the site is not blocked', async () => {
    const { site } = await createSite(db, 'Broken');
    h.queue.fail = true;
    await post(site.id).expect(500);
    h.queue.fail = false;
    expect(await h.attempts.findPending(site.id)).toBeNull();
    await post(site.id).expect(202);
  });
});

describe('incremental and repair requests', () => {
  it('defaults an incremental discovery to the unbound properties and pins the base version', async () => {
    const { customer, site } = await siteWithVersions(
      db,
      h.objects,
      h.specs,
      'Inc',
      [1],
      1,
    );
    // the fixture spec binds `launch`; the catalog declares gender, type, size, unit_system
    const res = await post(site.id, { mode: 'incremental' }).expect(202);
    const attempt = await h.attempts.get(customer.id, res.body.attemptId);
    expect(attempt.targetProperties).toEqual([
      'gender',
      'type',
      'size',
      'unit_system',
    ]);
    expect(attempt.baseVersion).toBe(1);
    expect(h.queue.sent.at(-1)!.baseSpecKey).toBe(
      `customers/${customer.id}/sites/${site.id}/specs/1.json`,
    );
  });

  it('extends the latest stored version when none is active', async () => {
    const { site } = await siteWithVersions(
      db,
      h.objects,
      h.specs,
      'IncLatest',
      [1, 2],
    );
    await db.pool.query(
      `INSERT INTO discovery_attempts (site_id, mode, schema_version, schema_snapshot, status) VALUES ($1, 'full', 1, '{}', 'candidate_ready') RETURNING id`,
      [site.id],
    );
    // latest stored version comes from site_spec_versions
    const { rows } = await db.pool.query(
      'SELECT id FROM discovery_attempts WHERE site_id = $1',
      [site.id],
    );
    await db.pool.query(
      `INSERT INTO site_spec_versions (site_id, version, mode, attempt_id, schema_version) VALUES ($1, 1, 'full', $2, 1), ($1, 2, 'full', $2, 1)`,
      [site.id, rows[0].id],
    );
    const res = await post(site.id, {
      mode: 'incremental',
      properties: ['gender'],
    }).expect(202);
    expect(h.queue.sent.at(-1)).toMatchObject({
      attemptId: res.body.attemptId,
      baseVersion: 2,
      targetProperties: ['gender'],
    });
  });

  it('answers 422 for a property the base already binds and 409 no_base_spec without a base', async () => {
    const { customer, site } = await siteWithVersions(
      db,
      h.objects,
      h.specs,
      'IncBad',
      [1],
      1,
    );
    await db.pool.query(
      `UPDATE catalog_schema_versions SET properties = properties || '[{"name":"launch","type":"string","description":"d","required":false,"filterable":false}]'::jsonb
        WHERE catalog_id = (SELECT catalog_id FROM sites WHERE id = $1)`,
      [site.id],
    );
    await post(site.id, { mode: 'incremental', properties: ['launch'] }).expect(
      422,
    );

    const bare = await createSite(db, 'IncNone');
    const res = await post(bare.site.id, { mode: 'incremental' }).expect(409);
    expect(res.body.code).toBe('no_base_spec');
    void customer;
  });

  it('defaults a repair to the failing properties of the last scrape and requires an active spec', async () => {
    const { site } = await siteWithVersions(
      db,
      h.objects,
      h.specs,
      'Repair',
      [1],
      1,
    );
    await post(site.id, { mode: 'repair' }).expect(422); // no failing properties known
    await db.pool.query(
      `INSERT INTO scrape_runs (site_id, mode, spec_version, schema_version, status, reason, failing_properties, finished_at)
       VALUES ($1, 'production', 1, 1, 'failed', 'parse_anomaly', '{launch,color}', now())`,
      [site.id],
    );
    const res = await post(site.id, { mode: 'repair' }).expect(202);
    expect(h.queue.sent.at(-1)).toMatchObject({
      attemptId: res.body.attemptId,
      mode: 'repair',
      targetProperties: ['launch'],
      baseVersion: 1,
    });

    const noActive = await siteWithVersions(
      db,
      h.objects,
      h.specs,
      'RepairNone',
      [1],
    );
    const conflict = await post(noActive.site.id, {
      mode: 'repair',
      properties: ['launch'],
    }).expect(409);
    expect(conflict.body.code).toBe('no_base_spec');
  });

  it('rejects a repair of an unbound property or a system field', async () => {
    const { site } = await siteWithVersions(
      db,
      h.objects,
      h.specs,
      'RepairBad',
      [1],
      1,
    );
    await post(site.id, { mode: 'repair', properties: ['gender'] }).expect(422);
    await post(site.id, { mode: 'repair', properties: ['price'] }).expect(422);
  });

  it('keeps the schema as it was at request time when a description is edited later', async () => {
    const { customer, site } = await createSite(db, 'Snapshot');
    const res = await post(site.id).expect(202);
    await db.pool.query(
      `UPDATE catalog_schema_versions
          SET properties = jsonb_set(properties, '{0,description}', '"EDITED"')
        WHERE catalog_id = (SELECT catalog_id FROM sites WHERE id = $1)`,
      [site.id],
    );
    const context = await h.attempts.getContext(res.body.attemptId);
    expect(context!.snapshot.properties[0].description).toBe('Audience');
    expect(
      h.queue.sent.find((m) => m.attemptId === res.body.attemptId)!.snapshot
        .properties[0].description,
    ).toBe('Audience');
    void customer;
  });
});

describe('discovery tables', () => {
  it('refuses a second pending attempt for a site and a duplicate version number', async () => {
    const { site } = await createSite(db, 'Constraints');
    const insert = () =>
      db.pool.query(
        `INSERT INTO discovery_attempts (site_id, mode, schema_version, schema_snapshot) VALUES ($1, 'full', 1, '{}') RETURNING id`,
        [site.id],
      );
    const first = await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
    await db.pool.query(
      `UPDATE discovery_attempts SET status = 'failed', reason = 'error' WHERE id = $1`,
      [first.rows[0].id],
    );
    await insert(); // allowed once the first is done

    const versionInsert = () =>
      db.pool.query(
        `INSERT INTO site_spec_versions (site_id, version, mode, attempt_id, schema_version) VALUES ($1, 1, 'full', $2, 1)`,
        [site.id, first.rows[0].id],
      );
    await versionInsert();
    await expect(versionInsert()).rejects.toMatchObject({ code: '23505' });
  });
});
