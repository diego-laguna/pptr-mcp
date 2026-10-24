import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../../src/database/database.module.js';
import {
  applyDevSeed,
  DEV_CATALOG_NAME,
  DEV_SITES,
  runDevSeedIfEnabled,
} from '../../src/seed/dev-seed.js';
import { SeedModule } from '../../src/seed/seed.module.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';

let db: TestDatabase;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.close();
});

const counts = async () =>
  (
    await db.pool.query(
      `SELECT (SELECT count(*)::int FROM customers) AS customers,
              (SELECT count(*)::int FROM catalogs) AS catalogs,
              (SELECT count(*)::int FROM sites) AS sites`,
    )
  ).rows[0];

describe('development seed', () => {
  it('creates one customer owning one catalog with the five PRD sites', async () => {
    const result = await runDevSeedIfEnabled(db.pool, {
      SEED_DEV_DATA: 'true',
    });
    expect(result?.sitesCreated).toBe(5);
    expect(await counts()).toEqual({ customers: 1, catalogs: 1, sites: 5 });

    const sites = await db.pool.query(
      'SELECT url, country, currency FROM sites ORDER BY url',
    );
    expect(
      sites.rows
        .map((r) => r.url)
        .sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual(DEV_SITES.map((s) => s.url).sort());
    expect(
      sites.rows.every((r) => r.country === 'AR' && r.currency === 'ARS'),
    ).toBe(true);

    const catalog = await db.pool.query(
      `SELECT c.name, c.schema_version, v.variant_property, v.properties
       FROM catalogs c JOIN catalog_schema_versions v ON v.catalog_id = c.id AND v.version = c.schema_version`,
    );
    expect(catalog.rows[0]).toMatchObject({
      name: DEV_CATALOG_NAME,
      schema_version: 1,
      variant_property: 'size',
    });
    expect(
      catalog.rows[0].properties.map((p: { name: string }) => p.name),
    ).toEqual(['gender', 'type', 'size', 'unit_system']);
  });

  it('does nothing unless explicitly enabled', async () => {
    expect(await runDevSeedIfEnabled(db.pool, {})).toBeUndefined();
    expect(
      await runDevSeedIfEnabled(db.pool, { SEED_DEV_DATA: 'false' }),
    ).toBeUndefined();
    expect(await counts()).toEqual({ customers: 0, catalogs: 0, sites: 0 });
  });

  it('applies twice without duplicating anything or changing identifiers', async () => {
    const first = await applyDevSeed(db.pool);
    const before = (await db.pool.query('SELECT id FROM sites ORDER BY url'))
      .rows;

    const second = await applyDevSeed(db.pool);

    expect(second).toMatchObject({
      customerId: first.customerId,
      catalogId: first.catalogId,
      sitesCreated: 0,
    });
    expect(await counts()).toEqual({ customers: 1, catalogs: 1, sites: 5 });
    expect(
      (await db.pool.query('SELECT id FROM sites ORDER BY url')).rows,
    ).toEqual(before);
    const versions = await db.pool.query(
      'SELECT count(*)::int AS n FROM catalog_schema_versions',
    );
    expect(versions.rows[0].n).toBe(1);
  });

  it('restores a missing site on re-apply without touching the others', async () => {
    await applyDevSeed(db.pool);
    await db.pool.query(
      "DELETE FROM sites WHERE url = 'https://www.mimo.com.ar/'",
    );
    const again = await applyDevSeed(db.pool);
    expect(again.sitesCreated).toBe(1);
    expect((await counts()).sites).toBe(5);
  });
});

describe('application start-up wiring', () => {
  async function boot(env: Record<string, string | undefined>) {
    const saved = { ...process.env };
    Object.assign(process.env, { DATABASE_URL: db.url }, env);
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
    }
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [DatabaseModule, SeedModule],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      await app.close();
    } finally {
      process.env = saved;
    }
  }

  it('starts empty by default', async () => {
    await boot({ SEED_DEV_DATA: undefined });
    expect(await counts()).toEqual({ customers: 0, catalogs: 0, sites: 0 });
  });

  it('is populated when the switch is on', async () => {
    await boot({ SEED_DEV_DATA: 'true' });
    expect(await counts()).toEqual({ customers: 1, catalogs: 1, sites: 5 });
  });
});
