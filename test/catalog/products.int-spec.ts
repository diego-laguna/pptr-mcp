import { CatalogsRepository } from '../../src/catalog/catalogs.repository.js';
import { CustomersRepository } from '../../src/catalog/customers.repository.js';
import {
  ConflictError,
  NotFoundError,
  StaleSchemaError,
  ValidationFailedError,
} from '../../src/catalog/errors.js';
import { ProductsRepository } from '../../src/catalog/products.repository.js';
import { SchemaChangeService } from '../../src/catalog/schema-change.service.js';
import { SitesRepository } from '../../src/catalog/sites.repository.js';
import { plainSchema } from '../support/fixtures.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';

const richSchema = {
  properties: [
    {
      name: 'gender',
      type: 'enum',
      description: 'Audience',
      values: ['girls', 'boys'],
      required: true,
    },
    { name: 'type', type: 'string', description: 'Garment type' },
    { name: 'promotion_date', type: 'date', description: 'Promotion date' },
    { name: 'size', type: 'string', description: 'Size', variant: true },
  ],
};

let db: TestDatabase;
let customers: CustomersRepository;
let catalogs: CatalogsRepository;
let sites: SitesRepository;
let products: ProductsRepository;
let changes: SchemaChangeService;

beforeAll(async () => {
  db = await createTestDatabase();
  customers = new CustomersRepository(db.pool);
  catalogs = new CatalogsRepository(db.pool);
  sites = new SitesRepository(db.pool);
  products = new ProductsRepository(db.pool);
  changes = new SchemaChangeService(db.pool);
});

afterAll(async () => {
  await db.close();
});

let counter = 0;
async function setup(
  schema: unknown = richSchema,
  name = `Customer ${++counter}`,
) {
  const customer = await customers.create(name);
  const catalog = await catalogs.create(customer.id, 'catalog', schema);
  const site = await sites.add(customer.id, catalog.id, {
    url: `https://shop${counter}.example/`,
    name: 'Shop',
    country: 'AR',
    currency: 'ARS',
  });
  return { customer, catalog, site };
}

const variants = [{ value: '10', price: '$ 12.990,00', available: true }];

const codes = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e) => e);
  expect(error).toBeInstanceOf(ValidationFailedError);
  return (error as ValidationFailedError).issues.map((i) => i.code);
};

describe('product identity', () => {
  it('rejects a second product with the same site and link', async () => {
    const { customer, site } = await setup();
    const input = {
      name: 'A',
      link: 'https://shop.example/a',
      attributes: { gender: 'girls' },
    };
    await products.create(customer.id, site.id, 1, input);
    await expect(
      products.create(customer.id, site.id, 1, input),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('accepts the same link under two different sites', async () => {
    const { customer, catalog, site } = await setup();
    const other = await sites.add(customer.id, catalog.id, {
      url: 'https://other.example/',
      name: 'Other',
      country: 'AR',
      currency: 'ARS',
    });
    const input = {
      name: 'A',
      link: 'https://shop.example/a',
      attributes: { gender: 'girls' },
    };
    await products.create(customer.id, site.id, 1, input);
    await expect(
      products.create(customer.id, other.id, 1, input),
    ).resolves.toBeTruthy();
  });
});

describe('attributes follow the schema', () => {
  const create = (attributes: unknown) =>
    setup().then(({ customer, site }) =>
      products.create(customer.id, site.id, 1, {
        name: 'A',
        link: 'https://shop.example/a',
        attributes: attributes as Record<string, unknown>,
      }),
    );

  it('rejects an undeclared attribute', async () => {
    expect(await codes(create({ gender: 'girls', color: 'red' }))).toContain(
      'undeclared_property',
    );
  });

  it('rejects a wrong value type', async () => {
    expect(await codes(create({ gender: 'girls', type: 5 }))).toContain(
      'invalid_value',
    );
  });

  it('rejects a value outside the enum', async () => {
    expect(await codes(create({ gender: 'adults' }))).toContain(
      'value_not_allowed',
    );
  });

  it('accepts a valid date and reads it back unchanged', async () => {
    const { customer, site } = await setup();
    const created = await products.create(customer.id, site.id, 1, {
      name: 'A',
      link: 'https://shop.example/a',
      attributes: { gender: 'girls', promotion_date: '2026-10-15' },
    });
    const read = await products.get(customer.id, created.id);
    expect(read.attributes.promotion_date).toBe('2026-10-15');
  });

  it.each(['15/10/2026', '2026-02-31'])('rejects date %s', async (value) => {
    expect(
      await codes(create({ gender: 'girls', promotion_date: value })),
    ).toContain('invalid_value');
  });

  it('accepts a missing optional property', async () => {
    const { customer, site } = await setup();
    const created = await products.create(customer.id, site.id, 1, {
      name: 'A',
      link: 'https://shop.example/a',
      attributes: { gender: 'girls' },
    });
    expect(created.attributes).toEqual({ gender: 'girls' });
  });

  it('rejects a missing required property', async () => {
    expect(await codes(create({ type: 't-shirt' }))).toContain(
      'missing_required',
    );
  });

  it('stores nothing when validation fails', async () => {
    const { customer, site } = await setup();
    await products
      .create(customer.id, site.id, 1, {
        name: 'A',
        link: 'l',
        attributes: { type: 'x' },
      })
      .catch(() => undefined);
    expect(await products.search(customer.id, { siteId: site.id })).toEqual([]);
  });
});

describe('writes are pinned to a schema version', () => {
  it('rejects a stale write and stores nothing', async () => {
    const { customer, catalog, site } = await setup();
    await changes.apply(customer.id, catalog.id, [
      {
        op: 'add_property',
        property: { name: 'fabric', type: 'string', description: 'Fabric' },
      },
    ]);
    const error = await products
      .create(customer.id, site.id, 1, {
        name: 'A',
        link: 'l',
        attributes: { gender: 'girls' },
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(StaleSchemaError);
    expect(error).toMatchObject({ pinnedVersion: 1, currentVersion: 2 });
    expect(await products.search(customer.id, { siteId: site.id })).toEqual([]);
  });

  it('accepts a write under the current version', async () => {
    const { customer, catalog, site } = await setup();
    await changes.apply(customer.id, catalog.id, [
      {
        op: 'add_property',
        property: { name: 'fabric', type: 'string', description: 'Fabric' },
      },
    ]);
    await expect(
      products.create(customer.id, site.id, 2, {
        name: 'A',
        link: 'l',
        attributes: { gender: 'girls', fabric: 'cotton' },
      }),
    ).resolves.toBeTruthy();
  });

  it('does not let an old-key write land after a rename', async () => {
    const { customer, catalog, site } = await setup();
    await products.create(customer.id, site.id, 1, {
      name: 'A',
      link: 'a',
      attributes: { gender: 'girls' },
    });
    await changes.apply(customer.id, catalog.id, [
      { op: 'rename_property', from: 'gender', to: 'audience' },
    ]);
    await expect(
      products.create(customer.id, site.id, 1, {
        name: 'B',
        link: 'b',
        attributes: { gender: 'boys' },
      }),
    ).rejects.toBeInstanceOf(StaleSchemaError);
    const stored = await products.search(customer.id, { siteId: site.id });
    expect(stored.map((p) => p.attributes)).toEqual([{ audience: 'girls' }]);
  });

  it('applies the same check on update', async () => {
    const { customer, catalog, site } = await setup();
    const created = await products.create(customer.id, site.id, 1, {
      name: 'A',
      link: 'a',
      attributes: { gender: 'girls' },
    });
    await changes.apply(customer.id, catalog.id, [
      {
        op: 'add_property',
        property: { name: 'fabric', type: 'string', description: 'Fabric' },
      },
    ]);
    await expect(
      products.update(customer.id, created.id, 1, {
        name: 'A2',
        link: 'a',
        attributes: { gender: 'girls' },
      }),
    ).rejects.toBeInstanceOf(StaleSchemaError);
    const updated = await products.update(customer.id, created.id, 2, {
      name: 'A2',
      link: 'a',
      attributes: { gender: 'girls', fabric: 'wool' },
    });
    expect(updated).toMatchObject({
      name: 'A2',
      attributes: { gender: 'girls', fabric: 'wool' },
    });
  });

  it('makes a schema change wait for an in-flight write', async () => {
    const { customer, catalog, site } = await setup();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM catalogs WHERE id = $1 FOR SHARE', [
        catalog.id,
      ]);
      let finished = false;
      const change = changes
        .apply(customer.id, catalog.id, [
          {
            op: 'add_property',
            property: { name: 'fabric', type: 'string', description: 'Fabric' },
          },
        ])
        .then(() => (finished = true));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(finished).toBe(false);
      await client.query('COMMIT');
      await change;
      expect(finished).toBe(true);
    } finally {
      client.release();
    }
    expect(site.id).toBeTruthy();
  });
});

describe('price shape depends on the variant property', () => {
  it('rejects a product-level price in a catalog with a variant property', async () => {
    const { customer, site } = await setup();
    expect(
      await codes(
        products.create(customer.id, site.id, 1, {
          name: 'A',
          link: 'a',
          attributes: { gender: 'girls' },
          price: '$ 100',
          available: true,
        }),
      ),
    ).toContain('price_on_product');
  });

  it('stores variants with price and availability in a catalog with a variant property', async () => {
    const { customer, site } = await setup();
    const created = await products.create(customer.id, site.id, 1, {
      name: 'A',
      link: 'a',
      attributes: { gender: 'girls' },
      variants,
    });
    expect(created.price).toBeNull();
    expect(created.variants).toHaveLength(1);
    expect(created.variants[0]).toMatchObject({
      variantValue: '10',
      price: '$ 12.990,00',
      available: true,
    });
  });

  it('rejects variants in a catalog without a variant property', async () => {
    const { customer, site } = await setup(plainSchema);
    expect(
      await codes(
        products.create(customer.id, site.id, 1, {
          name: 'A',
          link: 'a',
          variants,
        }),
      ),
    ).toContain('variants_without_variant_property');
  });

  it('stores price and availability on the product in a catalog without a variant property', async () => {
    const { customer, site } = await setup(plainSchema);
    const created = await products.create(customer.id, site.id, 1, {
      name: 'A',
      link: 'a',
      price: '$ 100',
      available: false,
    });
    expect(created).toMatchObject({
      price: '$ 100',
      available: false,
      variants: [],
    });
  });

  it('rejects incomplete and duplicate variants', async () => {
    const { customer, site } = await setup();
    const base = { name: 'A', link: 'a', attributes: { gender: 'girls' } };
    expect(
      await codes(
        products.create(customer.id, site.id, 1, {
          ...base,
          variants: [{ value: '10', price: '', available: true }],
        }),
      ),
    ).toContain('missing_price');
    expect(
      await codes(
        products.create(customer.id, site.id, 1, {
          ...base,
          variants: [
            { value: '10', price: '$ 1', available: true },
            { value: '10', price: '$ 2', available: false },
          ],
        }),
      ),
    ).toContain('duplicate_variant');
  });

  it('deletes variants with their product', async () => {
    const { customer, site } = await setup();
    const created = await products.create(customer.id, site.id, 1, {
      name: 'A',
      link: 'a',
      attributes: { gender: 'girls' },
      variants,
    });
    await products.delete(customer.id, created.id);
    const { rows } = await db.pool.query(
      'SELECT count(*)::int AS n FROM product_variants WHERE product_id = $1',
      [created.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('replaces variants on update', async () => {
    const { customer, site } = await setup();
    const created = await products.create(customer.id, site.id, 1, {
      name: 'A',
      link: 'a',
      attributes: { gender: 'girls' },
      variants,
    });
    const updated = await products.update(customer.id, created.id, 1, {
      name: 'A',
      link: 'a',
      attributes: { gender: 'girls' },
      variants: [{ value: '12', price: '$ 1', available: false }],
    });
    expect(updated.variants.map((v) => v.variantValue)).toEqual(['12']);
  });
});

describe('price text round-trips exactly', () => {
  it.each(['$ 12.990,00', '  $12,990.50 ', 'USD 1,5', '1.234,5€'])(
    'keeps %j',
    async (price) => {
      const { customer, site } = await setup();
      const created = await products.create(customer.id, site.id, 1, {
        name: 'A',
        link: 'a',
        attributes: { gender: 'girls' },
        variants: [{ value: '10', price, available: true }],
      });
      const read = await products.get(customer.id, created.id);
      expect(read.variants[0].price).toBe(price);
    },
  );

  it('keeps a product-level price exactly', async () => {
    const { customer, site } = await setup(plainSchema);
    const created = await products.create(customer.id, site.id, 1, {
      name: 'A',
      link: 'a',
      price: '$ 12.990,00',
    });
    expect((await products.get(customer.id, created.id)).price).toBe(
      '$ 12.990,00',
    );
  });
});

describe('supported lookups', () => {
  async function seeded() {
    const a = await setup(richSchema, `Lookup ${++counter}`);
    const extraSite = await sites.add(a.customer.id, a.catalog.id, {
      url: 'https://second.example/',
      name: 'Second',
      country: 'AR',
      currency: 'ARS',
    });
    const make = (
      siteId: string,
      name: string,
      attributes: Record<string, unknown>,
      vs: typeof variants = [],
    ) =>
      products.create(a.customer.id, siteId, 1, {
        name,
        link: `https://x.example/${name}`,
        attributes,
        variants: vs,
      });
    const tshirtGirls = await make(
      a.site.id,
      'Remera rosa',
      { gender: 'girls', type: 't-shirt' },
      [
        { value: '10', price: '$ 1', available: true },
        { value: '12', price: '$ 2', available: true },
      ],
    );
    await make(a.site.id, 'Remera azul', { gender: 'boys', type: 't-shirt' }, [
      { value: '10', price: '$ 3', available: false },
    ]);
    await make(
      extraSite.id,
      'Pantalon gris',
      { gender: 'girls', type: 'pants' },
      [{ value: '14', price: '$ 4', available: true }],
    );
    return { ...a, extraSite, tshirtGirls };
  }

  it('selects by catalog and by site', async () => {
    const { customer, catalog, site, extraSite } = await seeded();
    expect(
      await products.search(customer.id, { catalogId: catalog.id }),
    ).toHaveLength(3);
    expect(
      await products.search(customer.id, { siteId: site.id }),
    ).toHaveLength(2);
    expect(
      await products.search(customer.id, { siteId: extraSite.id }),
    ).toHaveLength(1);
  });

  it('selects by attribute containment', async () => {
    const { customer, catalog, tshirtGirls } = await seeded();
    const found = await products.search(customer.id, {
      catalogId: catalog.id,
      attributes: { gender: 'girls', type: 't-shirt' },
    });
    expect(found.map((p) => p.id)).toEqual([tshirtGirls.id]);
  });

  it('selects by free text on the name', async () => {
    const { customer, catalog } = await seeded();
    const found = await products.search(customer.id, {
      catalogId: catalog.id,
      text: 'remera',
    });
    expect(found.map((p) => p.name).sort()).toEqual([
      'Remera azul',
      'Remera rosa',
    ]);
    expect(
      await products.search(customer.id, {
        catalogId: catalog.id,
        text: 'gris',
      }),
    ).toHaveLength(1);
  });

  it('combines filters', async () => {
    const { customer, catalog } = await seeded();
    const found = await products.search(customer.id, {
      catalogId: catalog.id,
      attributes: { gender: 'girls' },
      text: 'remera',
    });
    expect(found.map((p) => p.name)).toEqual(['Remera rosa']);
  });

  it('returns variants by value with their product', async () => {
    const { customer, catalog } = await seeded();
    const found = await products.findVariantsByValue(customer.id, '10', {
      catalogId: catalog.id,
    });
    expect(found.map((m) => m.product.name).sort()).toEqual([
      'Remera azul',
      'Remera rosa',
    ]);
    expect(found.every((m) => m.variant.variantValue === '10')).toBe(true);
  });

  it('returns nothing for the same query as another customer', async () => {
    const { catalog } = await seeded();
    const other = await customers.create('Other');
    expect(
      await products.search(other.id, {
        catalogId: catalog.id,
        attributes: { gender: 'girls' },
      }),
    ).toEqual([]);
    expect(
      await products.search(other.id, {
        catalogId: catalog.id,
        text: 'remera',
      }),
    ).toEqual([]);
    expect(
      await products.findVariantsByValue(other.id, '10', {
        catalogId: catalog.id,
      }),
    ).toEqual([]);
  });

  it('pages results', async () => {
    const { customer, catalog } = await seeded();
    const first = await products.search(customer.id, {
      catalogId: catalog.id,
      limit: 2,
    });
    const rest = await products.search(customer.id, {
      catalogId: catalog.id,
      limit: 2,
      offset: 2,
    });
    expect(first).toHaveLength(2);
    expect(rest).toHaveLength(1);
  });
});

describe('tenant isolation for every entity (4.3)', () => {
  let owner: Awaited<ReturnType<typeof setup>>;
  let intruder: { id: string };
  let product: { id: string };
  let marker: { id: string };

  beforeAll(async () => {
    owner = await setup(richSchema, `Owner ${++counter}`);
    intruder = await customers.create(`Intruder ${counter}`);
    product = await products.create(owner.customer.id, owner.site.id, 1, {
      name: 'A',
      link: 'a',
      attributes: { gender: 'girls' },
    });
    marker = await sites.addMarker(
      owner.customer.id,
      owner.site.id,
      'property_pending',
      'fabric',
    );
  });

  const entities: Record<string, () => Record<string, () => Promise<unknown>>> =
    {
      catalog: () => ({
        get: () => catalogs.get(intruder.id, owner.catalog.id),
        schemaChange: () =>
          changes.apply(intruder.id, owner.catalog.id, [
            {
              op: 'add_property',
              property: { name: 'fabric', type: 'string', description: 'x' },
            },
          ]),
      }),
      schema: () => ({
        version: () =>
          catalogs.getSchemaVersion(intruder.id, owner.catalog.id, 1),
        versions: () =>
          catalogs.listSchemaVersions(intruder.id, owner.catalog.id),
      }),
      site: () => ({
        list: () => sites.list(intruder.id, owner.catalog.id),
        get: () => sites.get(intruder.id, owner.site.id),
        add: () =>
          sites.add(intruder.id, owner.catalog.id, {
            url: 'https://x.example/',
            name: 'x',
            country: 'AR',
            currency: 'ARS',
          }),
        remove: () => sites.remove(intruder.id, owner.site.id),
      }),
      marker: () => ({
        add: () => sites.addMarker(intruder.id, owner.site.id, 'x'),
        clear: () => sites.clearMarker(intruder.id, marker.id),
        list: () => sites.listActiveMarkers(intruder.id, owner.site.id),
      }),
      product: () => ({
        get: () => products.get(intruder.id, product.id),
        create: () =>
          products.create(intruder.id, owner.site.id, 1, {
            name: 'B',
            link: 'b',
            attributes: { gender: 'girls' },
          }),
        update: () =>
          products.update(intruder.id, product.id, 1, {
            name: 'B',
            link: 'a',
            attributes: { gender: 'girls' },
          }),
        delete: () => products.delete(intruder.id, product.id),
      }),
    };

  it.each(Object.keys(entities))(
    '%s: another customer gets "not found" and changes nothing',
    async (entity) => {
      for (const [label, attempt] of Object.entries(entities[entity]())) {
        const error = await attempt().catch((e) => e);
        expect(error, `${entity} ${label}`).toBeInstanceOf(NotFoundError);
      }
      expect(
        (await catalogs.get(owner.customer.id, owner.catalog.id)).schemaVersion,
      ).toBe(1);
      expect((await products.get(owner.customer.id, product.id)).name).toBe(
        'A',
      );
      expect(
        await sites.listActiveMarkers(owner.customer.id, owner.site.id),
      ).toHaveLength(1);
    },
  );

  it('lists and searches show nothing of another customer', async () => {
    expect(await catalogs.list(intruder.id)).toEqual([]);
    expect(
      await products.search(intruder.id, { siteId: owner.site.id }),
    ).toEqual([]);
  });
});
