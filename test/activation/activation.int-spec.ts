import request from 'supertest';
import { App } from 'supertest/types.js';
import { DbActiveSpecResolver } from '../../src/activation/db-active-spec.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';
import { getActive, setActive } from '../support/active.js';
import { buildActivationApp, createSiteWith, headers } from './support.js';

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
const daily = { expression: 'rate(1 day)' };

/** A site with versions 1..n stored and previewed. */
async function readySite(
  name: string,
  versions = 1,
  properties: Record<string, unknown>[] = [],
) {
  const ctx = await createSiteWith(db, name, properties);
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

describe('pointer and history records (1.1, 1.2)', () => {
  it('refuses a second pointer row and cascades history with the site', async () => {
    const { site } = await createSiteWith(db, 'Rows');
    await setActive(db.pool, site.id, 1);
    await expect(
      db.pool.query(
        'INSERT INTO site_active_specs (site_id, version) VALUES ($1, 2)',
        [site.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await db.pool.query(
      'INSERT INTO site_activations (site_id, version) VALUES ($1, 1)',
      [site.id],
    );
    await db.pool.query(
      'INSERT INTO site_schedules (site_id, expression) VALUES ($1, $2)',
      [site.id, 'rate(1 day)'],
    );
    await db.pool.query('DELETE FROM sites WHERE id = $1', [site.id]);
    for (const table of [
      'site_active_specs',
      'site_activations',
      'site_schedules',
    ]) {
      const { rows } = await db.pool.query(
        `SELECT 1 FROM ${table} WHERE site_id = $1`,
        [site.id],
      );
      expect(rows).toHaveLength(0);
    }
  });

  it('resolves no version before activation and the pointer after; a run keeps the version it was requested with', async () => {
    const ctx = await readySite('Resolve', 3);
    const resolver = new DbActiveSpecResolver(db.pool);
    expect(await resolver.resolve(ctx.customer.id, ctx.site.id)).toBeNull();
    await expect(
      h.scrapes.request({ mode: 'production', siteId: ctx.site.id }),
    ).rejects.toMatchObject({ code: 'no_active_spec' });

    await setActive(db.pool, ctx.site.id, 2);
    const { runId } = await h.scrapes.request({
      mode: 'production',
      siteId: ctx.site.id,
    });
    await setActive(db.pool, ctx.site.id, 3); // activated while the run is queued
    const { rows } = await db.pool.query(
      'SELECT spec_version FROM scrape_runs WHERE id = $1',
      [runId],
    );
    expect(rows[0].spec_version).toBe(2);
    expect(h.scrapeQueue.sent.at(-1)!.message.specVersion).toBe(2);
    expect(await resolver.resolve(ctx.customer.id, ctx.site.id)).toBe(3);
    // another customer sees no pointer at all
    expect(
      await resolver.resolve(
        (await createSiteWith(db, 'Stranger')).customer.id,
        ctx.site.id,
      ),
    ).toBeNull();
  });
});

describe('activation (2.1, 2.2, 2.6)', () => {
  it('activates a previewed version and records the history row', async () => {
    const ctx = await readySite('First');
    const res = await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
      approvedBy: 'reviewer',
    }).expect(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.activation).toMatchObject({
      siteId: ctx.site.id,
      version: 1,
      replacedVersion: null,
      approvedBy: 'reviewer',
      acknowledgedProperties: [],
    });
    expect(res.body.activation.previewRunId).toEqual(expect.any(String));
    expect(await getActive(db.pool, ctx.site.id)).toBe(1);
  });

  it('repeating the active version is a no-op success without a new record', async () => {
    const ctx = await readySite('Repeat');
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(200);
    const again = await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(200);
    expect(again.body.changed).toBe(false);
    const history = await get(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/activations`,
    ).expect(200);
    expect(history.body.activations).toHaveLength(1);
  });

  it('lets exactly one of two concurrent activations succeed; the other is stale_activation', async () => {
    const ctx = await readySite('Race', 3);
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(200);
    const results = await Promise.all([
      activate(ctx, { version: 2, expectedCurrent: 1 }),
      activate(ctx, { version: 3, expectedCurrent: 1 }),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.code).toBe('stale_activation');
    expect([2, 3]).toContain(await getActive(db.pool, ctx.site.id));
  });

  it('rejects an expectation that is not the current version', async () => {
    const ctx = await readySite('Stale', 2);
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(200);
    const res = await activate(ctx, { version: 2, expectedCurrent: 5 }).expect(
      409,
    );
    expect(res.body.code).toBe('stale_activation');
    expect(await getActive(db.pool, ctx.site.id)).toBe(1);
  });

  it('requires a succeeded preview of that exact version', async () => {
    const ctx = await createSiteWith(db, 'NoPreview');
    await h.addVersion(ctx.customer.id, ctx.site.id, 1);
    const res = await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(409);
    expect(res.body.code).toBe('preview_required');
    await h.addPreview(ctx.site.id, 1, 'failed');
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(409);
    await h.addPreview(ctx.site.id, 1, 'succeeded');
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(200);
  });

  it('does not accept a preview of a different version', async () => {
    const ctx = await createSiteWith(db, 'OtherPreview');
    await h.addVersion(ctx.customer.id, ctx.site.id, 1);
    await h.addVersion(ctx.customer.id, ctx.site.id, 2);
    await h.addPreview(ctx.site.id, 1);
    const res = await activate(ctx, {
      version: 2,
      expectedCurrent: null,
      cadence: daily,
    }).expect(409);
    expect(res.body.code).toBe('preview_required');
  });

  it('refuses a discarded version', async () => {
    const ctx = await readySite('Discarded');
    await post(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/1/discard`,
    ).expect(200);
    const res = await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(409);
    expect(res.body.code).toBe('discarded');
  });

  it('refuses a version that binds a property no longer in the schema', async () => {
    const ctx = await readySite('Renamed');
    await db.pool.query(
      `UPDATE catalog_schema_versions SET properties = (SELECT jsonb_agg(p) FROM jsonb_array_elements(properties) p WHERE p->>'name' <> 'type')
        WHERE catalog_id = $1`,
      [ctx.catalog.id],
    );
    const res = await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(409);
    expect(res.body.code).toBe('schema_changed');
    expect(await getActive(db.pool, ctx.site.id)).toBeNull();
  });

  it("answers 404 for another site's version, another customer, and 400 without the customer header", async () => {
    const a = await readySite('Mine');
    const b = await readySite('Theirs');
    await post(a.customer.id, `/internal/sites/${a.site.id}/activations`, {
      version: 99,
      expectedCurrent: null,
      cadence: daily,
    }).expect(404);
    await post(b.customer.id, `/internal/sites/${a.site.id}/activations`, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(404);
    await get(b.customer.id, `/internal/sites/${a.site.id}/activations`).expect(
      404,
    );
    await http()
      .post(`/internal/sites/${a.site.id}/activations`)
      .set({ Authorization: headers(a.customer.id).Authorization })
      .send({ version: 1 })
      .expect(400);
    await http()
      .post(`/internal/sites/${a.site.id}/activations`)
      .send({})
      .expect(401);
    expect(await getActive(db.pool, a.site.id)).toBeNull();
  });
});

describe('required-property acknowledgment (2.3)', () => {
  const required = [
    { name: 'fabric', type: 'string', description: 'Fabric', required: true },
    { name: 'season', type: 'string', description: 'Season' },
  ];

  it('activates with the unbound required property acknowledged and records it', async () => {
    const ctx = await readySite('Ack', 1, required);
    const res = await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
      acknowledge: ['fabric'],
    }).expect(200);
    expect(res.body.activation.acknowledgedProperties).toEqual(['fabric']);
  });

  it('rejects an activation that omits the acknowledgment and names the property', async () => {
    const ctx = await readySite('NoAck', 1, required);
    const res = await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(422);
    expect(res.body).toMatchObject({
      code: 'unacknowledged_properties',
      properties: ['fabric'],
    });
    expect(await getActive(db.pool, ctx.site.id)).toBeNull();
  });

  it('needs nothing for an unbound optional property and rejects names that are not unbound required ones', async () => {
    const ctx = await readySite('Optional', 1, [required[1]]);
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
      acknowledge: ['gender'],
    }).expect(422); // bound
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
      acknowledge: ['season'],
    }).expect(422); // optional
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(200);
  });
});

describe('markers (2.4)', () => {
  async function markers(siteId: string) {
    const { rows } = await db.pool.query(
      'SELECT property, reason, cleared_at IS NOT NULL AS cleared FROM site_attention WHERE site_id = $1 ORDER BY property',
      [siteId],
    );
    return rows;
  }

  it('clears pending markers for bound properties only and leaves other markers alone', async () => {
    const ctx = await readySite('Markers', 1, [
      { name: 'season', type: 'string', description: 'Season' },
    ]);
    for (const [property, reason] of [
      ['gender', 'property_pending'],
      ['season', 'property_pending'],
      [null, 'discovery_failed'],
    ] as const)
      await db.pool.query(
        'INSERT INTO site_attention (site_id, reason, property) VALUES ($1, $2, $3)',
        [ctx.site.id, reason, property],
      );
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(200);
    const rows = await markers(ctx.site.id);
    expect(rows.find((r) => r.property === 'gender')!.cleared).toBe(true);
    expect(rows.find((r) => r.property === 'season')!.cleared).toBe(false);
    expect(rows.find((r) => r.reason === 'discovery_failed')!.cleared).toBe(
      false,
    );
  });

  it('clears nothing when the activation is rejected', async () => {
    const ctx = await readySite('NoClear', 1, [
      { name: 'fabric', type: 'string', description: 'Fabric', required: true },
    ]);
    await db.pool.query(
      "INSERT INTO site_attention (site_id, reason, property) VALUES ($1, 'property_pending', 'gender')",
      [ctx.site.id],
    );
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(422); // fabric not acknowledged
    expect((await markers(ctx.site.id))[0].cleared).toBe(false);
  });

  it('rolls the whole transaction back if the pointer change cannot commit', async () => {
    const ctx = await readySite('Rollback');
    await db.pool.query(
      "INSERT INTO site_attention (site_id, reason, property) VALUES ($1, 'property_pending', 'gender')",
      [ctx.site.id],
    );
    // a trigger that refuses the history insert makes the last statement of the transaction fail
    await db.pool.query(
      `CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`,
    );
    await db.pool.query(
      'CREATE TRIGGER refuse_history BEFORE INSERT ON site_activations FOR EACH ROW EXECUTE FUNCTION refuse()',
    );
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(500);
    await db.pool.query('DROP TRIGGER refuse_history ON site_activations');
    expect((await markers(ctx.site.id))[0].cleared).toBe(false);
    expect(await getActive(db.pool, ctx.site.id)).toBeNull();
    const { rows } = await db.pool.query(
      'SELECT 1 FROM site_schedules WHERE site_id = $1',
      [ctx.site.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('rollback and discard (2.5)', () => {
  it('rolls back to a previously active version without a new preview and records the history', async () => {
    const ctx = await readySite('Back', 3);
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(200);
    await activate(ctx, { version: 2, expectedCurrent: 1 }).expect(200);
    await db.pool.query(
      "DELETE FROM scrape_runs WHERE site_id = $1 AND mode = 'preview' AND spec_version = 1",
      [ctx.site.id],
    );
    const back = await activate(ctx, { version: 1, expectedCurrent: 2 }).expect(
      200,
    );
    expect(back.body.activation).toMatchObject({
      version: 1,
      replacedVersion: 2,
      previewRunId: null,
    });
    expect(await getActive(db.pool, ctx.site.id)).toBe(1);
    const history = await get(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/activations`,
    ).expect(200);
    expect(
      history.body.activations.map((a: { version: number }) => a.version),
    ).toEqual([1, 2, 1]);
    const list = await get(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions`,
    ).expect(200);
    expect(list.body.activeVersion).toBe(1);
    expect(
      list.body.versions.map((v: { version: number }) => v.version),
    ).toEqual([3, 2, 1]);
  });

  it('discards a candidate but not the active version; discarded stays listed and cannot be activated', async () => {
    const ctx = await readySite('Discard', 2);
    await activate(ctx, {
      version: 1,
      expectedCurrent: null,
      cadence: daily,
    }).expect(200);
    await post(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/1/discard`,
    ).expect(409);
    await post(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/2/discard`,
    ).expect(200);
    const list = await get(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions`,
    ).expect(200);
    expect(
      list.body.versions.find((v: { version: number }) => v.version === 2)
        .discardedAt,
    ).toEqual(expect.any(String));
    await activate(ctx, { version: 2, expectedCurrent: 1 }).expect(409);
    await post(
      ctx.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/9/discard`,
    ).expect(404);
    const stranger = await createSiteWith(db, 'DiscardStranger');
    await post(
      stranger.customer.id,
      `/internal/sites/${ctx.site.id}/spec-versions/2/discard`,
    ).expect(404);
  });
});
