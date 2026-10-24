import { CatalogsRepository } from '../../src/catalog/catalogs.repository.js';
import { CustomersRepository } from '../../src/catalog/customers.repository.js';
import {
  ConflictError,
  NotFoundError,
  ValidationFailedError,
} from '../../src/catalog/errors.js';
import { clothingSchema, plainSchema } from '../support/fixtures.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';

let db: TestDatabase;
let customers: CustomersRepository;
let catalogs: CatalogsRepository;

beforeAll(async () => {
  db = await createTestDatabase();
  customers = new CustomersRepository(db.pool);
  catalogs = new CatalogsRepository(db.pool);
});

afterAll(async () => {
  await db.close();
});

describe('customers', () => {
  it('stores a customer with a generated identifier', async () => {
    const customer = await customers.create('Acme');
    expect(customer.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(customer.name).toBe('Acme');
    expect(await customers.get(customer.id)).toMatchObject({ name: 'Acme' });
  });

  it('requires a name', async () => {
    await expect(customers.create('  ')).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});

describe('catalogs', () => {
  it('lets one customer own several catalogs', async () => {
    const c = await customers.create('Several');
    await catalogs.create(c.id, 'kids clothing', clothingSchema);
    await catalogs.create(c.id, 'car parts', plainSchema);
    const names = (await catalogs.list(c.id)).map((x) => x.name).sort();
    expect(names).toEqual(['car parts', 'kids clothing']);
  });

  it('rejects a duplicate name for the same customer', async () => {
    const c = await customers.create('Dupes');
    await catalogs.create(c.id, 'kids clothing', clothingSchema);
    await expect(
      catalogs.create(c.id, 'kids clothing', clothingSchema),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('accepts the same name for different customers', async () => {
    const a = await customers.create('A');
    const b = await customers.create('B');
    await catalogs.create(a.id, 'kids clothing', clothingSchema);
    await expect(
      catalogs.create(b.id, 'kids clothing', clothingSchema),
    ).resolves.toBeTruthy();
  });

  it('starts at schema version 1 with the initial schema', async () => {
    const c = await customers.create('Versioned');
    const created = await catalogs.create(
      c.id,
      'kids clothing',
      clothingSchema,
    );
    expect(created.schemaVersion).toBe(1);
    expect(created.variantProperty).toBe('size');

    const loaded = await catalogs.get(c.id, created.id);
    expect(loaded.schemaVersion).toBe(1);
    expect(loaded.schema.properties.map((p) => p.name)).toEqual([
      'gender',
      'type',
      'size',
      'unit_system',
    ]);
    const v1 = await catalogs.getSchemaVersion(c.id, created.id, 1);
    expect(v1.changes).toEqual([]);
  });

  it('stores nothing when the initial schema is invalid', async () => {
    const c = await customers.create('Invalid');
    await expect(
      catalogs.create(c.id, 'bad', {
        properties: [{ name: 'price', type: 'string', description: 'x' }],
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(await catalogs.list(c.id)).toEqual([]);
    const { rows } = await db.pool.query(
      'SELECT count(*)::int AS n FROM catalog_schema_versions v JOIN catalogs c ON c.id = v.catalog_id WHERE c.customer_id = $1',
      [c.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('rejects a catalog for an unknown customer', async () => {
    await expect(
      catalogs.create('00000000-0000-0000-0000-000000000000', 'x', plainSchema),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answers "not found" for another customer\'s catalog, like a missing one', async () => {
    const a = await customers.create('Owner');
    const b = await customers.create('Other');
    const owned = await catalogs.create(a.id, 'private', plainSchema);

    const crossTenant = await catalogs.get(b.id, owned.id).catch((e) => e);
    const missing = await catalogs
      .get(b.id, '00000000-0000-0000-0000-000000000000')
      .catch((e) => e);
    expect(crossTenant).toBeInstanceOf(NotFoundError);
    expect(crossTenant.message).toBe(missing.message);
  });

  it("lists only the customer's own catalogs", async () => {
    const a = await customers.create('ListA');
    const b = await customers.create('ListB');
    await catalogs.create(a.id, 'a-only', plainSchema);
    await catalogs.create(b.id, 'b-only', plainSchema);
    expect((await catalogs.list(a.id)).map((c) => c.name)).toEqual(['a-only']);
  });
});
