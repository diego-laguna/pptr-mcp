import { CatalogsRepository } from '../../src/catalog/catalogs.repository.js';
import { CustomersRepository } from '../../src/catalog/customers.repository.js';
import {
  ConflictError,
  NotFoundError,
  ValidationFailedError,
} from '../../src/catalog/errors.js';
import { SitesRepository } from '../../src/catalog/sites.repository.js';
import { clothingSchema, plainSchema } from '../support/fixtures.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';

let db: TestDatabase;
let customers: CustomersRepository;
let catalogs: CatalogsRepository;
let sites: SitesRepository;

beforeAll(async () => {
  db = await createTestDatabase();
  customers = new CustomersRepository(db.pool);
  catalogs = new CatalogsRepository(db.pool);
  sites = new SitesRepository(db.pool);
});

afterAll(async () => {
  await db.close();
});

const site = (url: string) => ({
  url,
  name: 'Grisino',
  country: 'AR',
  currency: 'ARS',
});

async function setup(name = 'Owner') {
  const customer = await customers.create(name);
  const catalog = await catalogs.create(
    customer.id,
    'kids clothing',
    clothingSchema,
  );
  return { customer, catalog };
}

describe('site registry', () => {
  it('adds a valid site', async () => {
    const { customer, catalog } = await setup();
    const added = await sites.add(
      customer.id,
      catalog.id,
      site('https://www.grisino.com/'),
    );
    expect(added).toMatchObject({
      catalogId: catalog.id,
      country: 'AR',
      currency: 'ARS',
    });
    expect(
      (await sites.list(customer.id, catalog.id)).map((s) => s.id),
    ).toEqual([added.id]);
  });

  it('rejects a duplicate URL in the same catalog', async () => {
    const { customer, catalog } = await setup();
    await sites.add(customer.id, catalog.id, site('https://dupe.example/'));
    await expect(
      sites.add(customer.id, catalog.id, site('https://dupe.example/')),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('accepts the same URL in another catalog', async () => {
    const { customer, catalog } = await setup();
    const other = await catalogs.create(customer.id, 'second', plainSchema);
    await sites.add(customer.id, catalog.id, site('https://same.example/'));
    await expect(
      sites.add(customer.id, other.id, site('https://same.example/')),
    ).resolves.toBeTruthy();
  });

  it('validates the site fields', async () => {
    const { customer, catalog } = await setup();
    for (const bad of [
      { ...site('ftp://x.example/') },
      { ...site('not a url') },
      { ...site('https://x.example/'), country: 'ar' },
      { ...site('https://x.example/'), currency: 'PESOS' },
      { ...site('https://x.example/'), name: ' ' },
    ]) {
      await expect(
        sites.add(customer.id, catalog.id, bad),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    }
  });

  it('answers "not found" when adding to a missing or another customer\'s catalog', async () => {
    const { catalog } = await setup('Owner');
    const intruder = await customers.create('Intruder');
    await expect(
      sites.add(intruder.id, catalog.id, site('https://x.example/')),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      sites.add(
        intruder.id,
        '00000000-0000-0000-0000-000000000000',
        site('https://x.example/'),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("puts every site of a catalog under that catalog's one schema version", async () => {
    const { customer, catalog } = await setup();
    const a = await sites.add(
      customer.id,
      catalog.id,
      site('https://a.example/'),
    );
    const b = await sites.add(
      customer.id,
      catalog.id,
      site('https://b.example/'),
    );
    expect(a.catalogId).toBe(b.catalogId);
    expect((await catalogs.get(customer.id, a.catalogId)).schemaVersion).toBe(
      1,
    );
  });
});

describe('attention markers', () => {
  it('creates a marker with a reason and property', async () => {
    const { customer, catalog } = await setup();
    const s = await sites.add(
      customer.id,
      catalog.id,
      site('https://m1.example/'),
    );
    const marker = await sites.addMarker(
      customer.id,
      s.id,
      'property_pending',
      'fabric',
    );
    expect(marker).toMatchObject({
      siteId: s.id,
      reason: 'property_pending',
      property: 'fabric',
      clearedAt: null,
    });
    expect(await sites.listActiveMarkers(customer.id, s.id)).toHaveLength(1);
  });

  it('clears a marker but retains it as history', async () => {
    const { customer, catalog } = await setup();
    const s = await sites.add(
      customer.id,
      catalog.id,
      site('https://m2.example/'),
    );
    const marker = await sites.addMarker(
      customer.id,
      s.id,
      'property_pending',
      'fabric',
    );
    const cleared = await sites.clearMarker(customer.id, marker.id);
    expect(cleared.clearedAt).toBeInstanceOf(Date);

    expect(await sites.listActiveMarkers(customer.id, s.id)).toEqual([]);
    const history = await sites.listMarkerHistory(customer.id, s.id);
    expect(history.map((m) => m.id)).toEqual([marker.id]);

    const again = await sites.clearMarker(customer.id, marker.id);
    expect(again.clearedAt).toEqual(cleared.clearedAt);
  });

  it('does not block reading the site while a marker is active', async () => {
    const { customer, catalog } = await setup();
    const s = await sites.add(
      customer.id,
      catalog.id,
      site('https://m3.example/'),
    );
    await sites.addMarker(customer.id, s.id, 'property_pending', 'fabric');
    expect((await sites.get(customer.id, s.id)).id).toBe(s.id);
    await db.pool.query(
      "INSERT INTO products (site_id, name, link) VALUES ($1, 'p', 'https://m3.example/p')",
      [s.id],
    );
  });

  it('keeps markers private to the owning customer', async () => {
    const { customer, catalog } = await setup();
    const intruder = await customers.create('Intruder');
    const s = await sites.add(
      customer.id,
      catalog.id,
      site('https://m4.example/'),
    );
    const marker = await sites.addMarker(
      customer.id,
      s.id,
      'property_pending',
      'fabric',
    );
    await expect(
      sites.addMarker(intruder.id, s.id, 'x'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      sites.clearMarker(intruder.id, marker.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      sites.listActiveMarkers(intruder.id, s.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('removing a site', () => {
  it('deletes its products, variants and markers and leaves other sites alone', async () => {
    const { customer, catalog } = await setup();
    const doomed = await sites.add(
      customer.id,
      catalog.id,
      site('https://rm1.example/'),
    );
    const kept = await sites.add(
      customer.id,
      catalog.id,
      site('https://rm2.example/'),
    );
    for (const s of [doomed, kept]) {
      const { rows } = await db.pool.query(
        "INSERT INTO products (site_id, name, link) VALUES ($1, 'p', $2) RETURNING id",
        [s.id, `${s.url}p`],
      );
      await db.pool.query(
        "INSERT INTO product_variants (product_id, variant_value, price, available) VALUES ($1, '10', '$ 1', true)",
        [rows[0].id],
      );
      await sites.addMarker(customer.id, s.id, 'property_pending', 'fabric');
    }

    await sites.remove(customer.id, doomed.id);

    const count = async (table: string, where: string, id: string) =>
      (
        await db.pool.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
          [id],
        )
      ).rows[0].n;
    expect(await count('products', 'site_id = $1', doomed.id)).toBe(0);
    expect(await count('site_attention', 'site_id = $1', doomed.id)).toBe(0);
    expect(
      await count(
        'product_variants',
        'product_id IN (SELECT id FROM products WHERE site_id = $1)',
        doomed.id,
      ),
    ).toBe(0);
    expect(await count('products', 'site_id = $1', kept.id)).toBe(1);
    expect(await count('site_attention', 'site_id = $1', kept.id)).toBe(1);
    expect((await sites.get(customer.id, kept.id)).id).toBe(kept.id);
  });

  it('answers "not found" for another customer\'s site', async () => {
    const { customer, catalog } = await setup();
    const intruder = await customers.create('Intruder');
    const s = await sites.add(
      customer.id,
      catalog.id,
      site('https://rm3.example/'),
    );
    await expect(sites.remove(intruder.id, s.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(sites.get(intruder.id, s.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(sites.list(intruder.id, catalog.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await sites.get(customer.id, s.id)).id).toBe(s.id);
  });
});
