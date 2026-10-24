import { CatalogsRepository } from '../../src/catalog/catalogs.repository.js';
import { CustomersRepository } from '../../src/catalog/customers.repository.js';
import {
  NotFoundError,
  SchemaChangeRejectedError,
} from '../../src/catalog/errors.js';
import { SchemaChangeService } from '../../src/catalog/schema-change.service.js';
import { SitesRepository } from '../../src/catalog/sites.repository.js';
import { clothingSchema } from '../support/fixtures.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';

let db: TestDatabase;
let customers: CustomersRepository;
let catalogs: CatalogsRepository;
let sites: SitesRepository;
let changes: SchemaChangeService;

beforeAll(async () => {
  db = await createTestDatabase();
  customers = new CustomersRepository(db.pool);
  catalogs = new CatalogsRepository(db.pool);
  sites = new SitesRepository(db.pool);
  changes = new SchemaChangeService(db.pool);
});

afterAll(async () => {
  await db.close();
});

let counter = 0;
async function setup(
  options: { sites?: number; products?: Record<string, unknown>[] } = {},
) {
  const customer = await customers.create(`Customer ${++counter}`);
  const catalog = await catalogs.create(
    customer.id,
    'kids clothing',
    clothingSchema,
  );
  const siteIds: string[] = [];
  for (let i = 0; i < (options.sites ?? 1); i++) {
    const site = await sites.add(customer.id, catalog.id, {
      url: `https://s${counter}-${i}.example/`,
      name: `Site ${i}`,
      country: 'AR',
      currency: 'ARS',
    });
    siteIds.push(site.id);
  }
  let n = 0;
  for (const attributes of options.products ?? []) {
    await db.pool.query(
      'INSERT INTO products (site_id, name, link, attributes) VALUES ($1, $2, $3, $4)',
      [
        siteIds[0],
        `p${n}`,
        `https://s${counter}-0.example/p${n++}`,
        JSON.stringify(attributes),
      ],
    );
  }
  return { customer, catalog, siteIds };
}

async function snapshot(catalogId: string) {
  const version = (
    await db.pool.query('SELECT schema_version FROM catalogs WHERE id = $1', [
      catalogId,
    ])
  ).rows[0].schema_version;
  const versions = (
    await db.pool.query(
      'SELECT count(*)::int AS n FROM catalog_schema_versions WHERE catalog_id = $1',
      [catalogId],
    )
  ).rows[0].n;
  const attributes = (
    await db.pool.query(
      'SELECT p.attributes FROM products p JOIN sites s ON s.id = p.site_id WHERE s.catalog_id = $1 ORDER BY p.link',
      [catalogId],
    )
  ).rows.map((r) => r.attributes);
  const markers = (
    await db.pool.query(
      'SELECT a.property, a.reason, a.cleared_at FROM site_attention a JOIN sites s ON s.id = a.site_id WHERE s.catalog_id = $1 ORDER BY a.property, a.site_id',
      [catalogId],
    )
  ).rows;
  const properties = (
    await db.pool.query(
      'SELECT properties FROM catalog_schema_versions WHERE catalog_id = $1 AND version = $2',
      [catalogId, version],
    )
  ).rows[0].properties;
  return { version, versions, attributes, markers, properties };
}

const fabric = { name: 'fabric', type: 'string', description: 'Fabric' };

describe('adding a property', () => {
  it('creates a new version, leaves products alone and marks every site', async () => {
    const { customer, catalog, siteIds } = await setup({
      sites: 3,
      products: [{ gender: 'girls', type: 't-shirt' }],
    });
    const before = await snapshot(catalog.id);

    const result = await changes.apply(customer.id, catalog.id, [
      { op: 'add_property', property: fabric },
    ]);

    expect(result).toMatchObject({
      schemaVersion: 2,
      versionChanged: true,
      markersCreated: 3,
    });
    const after = await snapshot(catalog.id);
    expect(after.version).toBe(2);
    expect(after.attributes).toEqual(before.attributes);
    const pending = await Promise.all(
      siteIds.map((id) => sites.listActiveMarkers(customer.id, id)),
    );
    for (const markers of pending) {
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        reason: 'property_pending',
        property: 'fabric',
      });
    }
    const v2 = await catalogs.getSchemaVersion(customer.id, catalog.id, 2);
    expect(v2.changes).toEqual([{ op: 'add_property', property: fabric }]);
    expect(v2.schema.properties.map((p) => p.name)).toContain('fabric');
    const v1 = await catalogs.getSchemaVersion(customer.id, catalog.id, 1);
    expect(v1.schema.properties.map((p) => p.name)).not.toContain('fabric');
  });

  it('keeps every version retained across several changes', async () => {
    const { customer, catalog } = await setup();
    await changes.apply(customer.id, catalog.id, [
      { op: 'add_property', property: fabric },
    ]);
    await changes.apply(customer.id, catalog.id, [
      {
        op: 'add_property',
        property: { name: 'season', type: 'string', description: 'Season' },
      },
    ]);
    const versions = await catalogs.listSchemaVersions(customer.id, catalog.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect((await catalogs.get(customer.id, catalog.id)).schemaVersion).toBe(3);
  });

  it('does not mark a site that has no pending work when only the variant is renamed', async () => {
    const { customer, catalog, siteIds } = await setup();
    const result = await changes.apply(customer.id, catalog.id, [
      { op: 'rename_property', from: 'size', to: 'talle' },
    ]);
    expect(result.markersCreated).toBe(0);
    expect(await sites.listActiveMarkers(customer.id, siteIds[0])).toEqual([]);
  });
});

describe('renaming a property', () => {
  it('rewrites every product and drops the old key', async () => {
    const { customer, catalog, siteIds } = await setup({
      products: [
        { gender: 'girls', type: 't-shirt' },
        { gender: 'boys' },
        { type: 'pants' },
      ],
    });

    await changes.apply(customer.id, catalog.id, [
      { op: 'rename_property', from: 'gender', to: 'audience' },
    ]);

    const { attributes } = await snapshot(catalog.id);
    expect(attributes).toEqual([
      { audience: 'girls', type: 't-shirt' },
      { audience: 'boys' },
      { type: 'pants' },
    ]);
    expect(JSON.stringify(attributes)).not.toContain('gender');
    expect(await sites.listActiveMarkers(customer.id, siteIds[0])).toEqual([]);
  });

  it('renames the variant property and leaves stored variants alone', async () => {
    const { customer, catalog, siteIds } = await setup({
      products: [{ gender: 'girls' }],
    });
    const { rows } = await db.pool.query(
      'SELECT id FROM products WHERE site_id = $1',
      [siteIds[0]],
    );
    await db.pool.query(
      "INSERT INTO product_variants (product_id, variant_value, price, available) VALUES ($1, '10', '$ 1', true)",
      [rows[0].id],
    );

    await changes.apply(customer.id, catalog.id, [
      { op: 'rename_property', from: 'size', to: 'talle' },
    ]);

    expect((await catalogs.get(customer.id, catalog.id)).variantProperty).toBe(
      'talle',
    );
    const variants = await db.pool.query(
      'SELECT variant_value FROM product_variants',
    );
    expect(variants.rows.map((r) => r.variant_value)).toContain('10');
  });

  it('carries a pending marker along to the new name', async () => {
    const { customer, catalog, siteIds } = await setup();
    await changes.apply(customer.id, catalog.id, [
      { op: 'add_property', property: fabric },
    ]);
    await changes.apply(customer.id, catalog.id, [
      { op: 'rename_property', from: 'fabric', to: 'material' },
    ]);
    const markers = await sites.listActiveMarkers(customer.id, siteIds[0]);
    expect(markers.map((m) => m.property)).toEqual(['material']);
  });

  it('migrates chained renames in order', async () => {
    const { customer, catalog } = await setup({
      products: [{ gender: 'girls', type: 't-shirt' }],
    });
    await changes.apply(customer.id, catalog.id, [
      { op: 'rename_property', from: 'gender', to: 'tmp' },
      { op: 'rename_property', from: 'type', to: 'gender' },
      { op: 'rename_property', from: 'tmp', to: 'type' },
    ]);
    expect((await snapshot(catalog.id)).attributes).toEqual([
      { gender: 't-shirt', type: 'girls' },
    ]);
  });
});

describe('removing a property', () => {
  it('deletes the key from every product', async () => {
    const { customer, catalog } = await setup({
      products: [
        { gender: 'girls', unit_system: 'ar' },
        { unit_system: 'us' },
        { type: 'pants' },
      ],
    });
    await changes.apply(customer.id, catalog.id, [
      { op: 'remove_property', name: 'unit_system' },
    ]);
    const { attributes } = await snapshot(catalog.id);
    expect(attributes).toEqual([{ gender: 'girls' }, {}, { type: 'pants' }]);
  });

  it('clears the pending marker of a property that is removed', async () => {
    const { customer, catalog, siteIds } = await setup();
    await changes.apply(customer.id, catalog.id, [
      { op: 'add_property', property: fabric },
    ]);
    await changes.apply(customer.id, catalog.id, [
      { op: 'remove_property', name: 'fabric' },
    ]);
    expect(await sites.listActiveMarkers(customer.id, siteIds[0])).toEqual([]);
    expect(await sites.listMarkerHistory(customer.id, siteIds[0])).toHaveLength(
      1,
    );
  });
});

describe('rejections leave schema, data and markers unchanged', () => {
  const rejected = async (
    operations: Parameters<SchemaChangeService['apply']>[2],
    options: Parameters<typeof setup>[0],
    code: string,
  ) => {
    const { customer, catalog } = await setup(options);
    const before = await snapshot(catalog.id);
    const error = await changes
      .apply(customer.id, catalog.id, operations)
      .catch((e) => e);
    expect(error).toBeInstanceOf(SchemaChangeRejectedError);
    expect(error.issues.map((i: { code: string }) => i.code)).toContain(code);
    expect(await snapshot(catalog.id)).toEqual(before);
  };

  it('required property with existing products', () =>
    rejected(
      [{ op: 'add_property', property: { ...fabric, required: true } }],
      { sites: 2, products: [{ gender: 'girls' }] },
      'required_with_existing_products',
    ));

  it('retype', () =>
    rejected(
      [{ op: 'edit_property', name: 'type', type: 'number' }],
      { products: [{ type: 'x' }] },
      'retype_not_supported',
    ));

  it('variant property removal', () =>
    rejected([{ op: 'remove_property', name: 'size' }], {}, 'variant_removal'));

  it('later variant designation', () =>
    rejected(
      [
        {
          op: 'add_property',
          property: {
            name: 'color',
            type: 'string',
            description: 'c',
            variant: true,
          },
        },
      ],
      {},
      'variant_designation_fixed',
    ));

  it('name collision', () =>
    rejected(
      [{ op: 'rename_property', from: 'gender', to: 'type' }],
      { products: [{ gender: 'girls' }] },
      'name_collision',
    ));

  it('enum value in use', () =>
    rejected(
      [{ op: 'remove_enum_value', name: 'gender', value: 'girls' }],
      { products: [{ gender: 'girls' }] },
      'enum_value_in_use',
    ));

  it('a later bad operation undoes an earlier good one', async () => {
    const { customer, catalog } = await setup({
      sites: 2,
      products: [{ gender: 'girls' }],
    });
    const before = await snapshot(catalog.id);
    await expect(
      changes.apply(customer.id, catalog.id, [
        { op: 'add_property', property: fabric },
        { op: 'rename_property', from: 'gender', to: 'type' },
      ]),
    ).rejects.toBeInstanceOf(SchemaChangeRejectedError);
    expect(await snapshot(catalog.id)).toEqual(before);
  });

  it('removing an enum value that no product uses succeeds', async () => {
    const { customer, catalog } = await setup({
      products: [{ gender: 'girls' }],
    });
    const result = await changes.apply(customer.id, catalog.id, [
      { op: 'remove_enum_value', name: 'gender', value: 'boys' },
    ]);
    expect(result.schemaVersion).toBe(2);
  });
});

describe('atomicity and concurrency', () => {
  it('rolls everything back when a rename migration fails part-way', async () => {
    const { customer, catalog } = await setup({
      sites: 2,
      products: [{ gender: 'girls' }, { gender: 'boys' }],
    });
    await changes.apply(customer.id, catalog.id, [
      { op: 'add_property', property: fabric },
    ]);
    const before = await snapshot(catalog.id);

    await db.pool.query(`
      CREATE FUNCTION fail_on_audience() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.attributes ? 'audience' AND NEW.link LIKE '%p1' THEN
          RAISE EXCEPTION 'forced failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_on_audience BEFORE UPDATE ON products
        FOR EACH ROW EXECUTE FUNCTION fail_on_audience();
    `);
    try {
      await expect(
        changes.apply(customer.id, catalog.id, [
          {
            op: 'add_property',
            property: { name: 'season', type: 'string', description: 'Season' },
          },
          { op: 'rename_property', from: 'gender', to: 'audience' },
        ]),
      ).rejects.toThrow(/forced failure/);
    } finally {
      await db.pool.query(
        'DROP TRIGGER fail_on_audience ON products; DROP FUNCTION fail_on_audience();',
      );
    }

    expect(await snapshot(catalog.id)).toEqual(before);
  });

  it('rolls back the version when marker creation fails', async () => {
    const { customer, catalog } = await setup({ sites: 2 });
    const before = await snapshot(catalog.id);
    await db.pool.query(`
      CREATE FUNCTION fail_marker() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'marker failure'; END $$;
      CREATE TRIGGER fail_marker BEFORE INSERT ON site_attention
        FOR EACH ROW EXECUTE FUNCTION fail_marker();
    `);
    try {
      await expect(
        changes.apply(customer.id, catalog.id, [
          { op: 'add_property', property: fabric },
        ]),
      ).rejects.toThrow(/marker failure/);
    } finally {
      await db.pool.query(
        'DROP TRIGGER fail_marker ON site_attention; DROP FUNCTION fail_marker();',
      );
    }
    expect(await snapshot(catalog.id)).toEqual(before);
  });

  it('applies two simultaneous changes one after the other', async () => {
    const { customer, catalog } = await setup({ sites: 2 });
    const results = await Promise.all([
      changes.apply(customer.id, catalog.id, [
        { op: 'add_property', property: fabric },
      ]),
      changes.apply(customer.id, catalog.id, [
        {
          op: 'add_property',
          property: { name: 'season', type: 'string', description: 'Season' },
        },
      ]),
    ]);
    expect(results.map((r) => r.schemaVersion).sort((a, b) => a - b)).toEqual([
      2, 3,
    ]);
    const latest = await catalogs.get(customer.id, catalog.id);
    expect(latest.schemaVersion).toBe(3);
    expect(latest.schema.properties.map((p) => p.name)).toEqual(
      expect.arrayContaining(['fabric', 'season']),
    );
    const versions = await catalogs.listSchemaVersions(customer.id, catalog.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('serializes a rename and a conflicting add so the second sees the first', async () => {
    const { customer, catalog } = await setup();
    const outcomes = await Promise.allSettled([
      changes.apply(customer.id, catalog.id, [
        { op: 'rename_property', from: 'gender', to: 'audience' },
      ]),
      changes.apply(customer.id, catalog.id, [
        {
          op: 'add_property',
          property: { name: 'audience', type: 'string', description: 'x' },
        },
      ]),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
  });
});

describe('edits without data migration', () => {
  it('applies a description-only edit in place without a new version', async () => {
    const { customer, catalog } = await setup({
      products: [{ gender: 'girls' }],
    });
    const before = await snapshot(catalog.id);

    const result = await changes.apply(customer.id, catalog.id, [
      {
        op: 'edit_property',
        name: 'type',
        description: 'The kind of garment',
        example: 't-shirt',
        filterable: false,
      },
    ]);

    expect(result).toMatchObject({
      schemaVersion: 1,
      versionChanged: false,
      markersCreated: 0,
    });
    const after = await snapshot(catalog.id);
    expect(after.versions).toBe(1);
    expect(after.version).toBe(1);
    expect(after.attributes).toEqual(before.attributes);
    expect(after.markers).toEqual([]);
    const v1 = await catalogs.getSchemaVersion(customer.id, catalog.id, 1);
    expect(v1.schema.properties.find((p) => p.name === 'type')).toMatchObject({
      description: 'The kind of garment',
      example: 't-shirt',
    });
    expect(v1.changes).toHaveLength(1);
  });

  it('adds an enum value with a new version, no migration and no markers', async () => {
    const { customer, catalog, siteIds } = await setup({
      products: [{ gender: 'girls' }],
    });
    const before = await snapshot(catalog.id);

    const result = await changes.apply(customer.id, catalog.id, [
      { op: 'add_enum_value', name: 'gender', value: 'unisex' },
    ]);

    expect(result).toMatchObject({
      schemaVersion: 2,
      versionChanged: true,
      markersCreated: 0,
    });
    const after = await snapshot(catalog.id);
    expect(after.attributes).toEqual(before.attributes);
    expect(await sites.listActiveMarkers(customer.id, siteIds[0])).toEqual([]);
  });
});

describe('scoping', () => {
  it('answers "not found" for another customer\'s catalog and changes nothing', async () => {
    const { catalog } = await setup();
    const intruder = await customers.create('Intruder');
    const before = await snapshot(catalog.id);
    await expect(
      changes.apply(intruder.id, catalog.id, [
        { op: 'add_property', property: fabric },
      ]),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await snapshot(catalog.id)).toEqual(before);
  });
});
