import { createTestDatabase, TestDatabase } from '../support/test-database.js';
import { migrate } from '../support/migrate.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

const q = (text: string, values: unknown[] = []) => db.pool.query(text, values);

async function customer(name = 'Acme') {
  const { rows } = await q(
    'INSERT INTO customers (name) VALUES ($1) RETURNING id',
    [name],
  );
  return rows[0].id as string;
}

async function catalog(customerId: string, name: string) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO catalogs (customer_id, name) VALUES ($1, $2) RETURNING id',
      [customerId, name],
    );
    await client.query(
      "INSERT INTO catalog_schema_versions (catalog_id, version, properties) VALUES ($1, 1, '[]')",
      [rows[0].id],
    );
    await client.query('COMMIT');
    return rows[0].id as string;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function site(catalogId: string, url: string) {
  const { rows } = await q(
    "INSERT INTO sites (catalog_id, url, name, country, currency) VALUES ($1, $2, 'S', 'AR', 'ARS') RETURNING id",
    [catalogId, url],
  );
  return rows[0].id as string;
}

async function product(
  siteId: string,
  link: string,
  extra: { name?: string; attributes?: object } = {},
) {
  const { rows } = await q(
    'INSERT INTO products (site_id, name, link, attributes) VALUES ($1, $2, $3, $4) RETURNING id',
    [
      siteId,
      extra.name ?? 'Product',
      link,
      JSON.stringify(extra.attributes ?? {}),
    ],
  );
  return rows[0].id as string;
}

describe('customers and catalogs (3.1)', () => {
  it('rejects a duplicate catalog name for one customer', async () => {
    const c = await customer();
    await catalog(c, 'kids clothing');
    await expect(catalog(c, 'kids clothing')).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('accepts the same catalog name for two customers', async () => {
    const a = await customer('A');
    const b = await customer('B');
    await catalog(a, 'kids clothing');
    await expect(catalog(b, 'kids clothing')).resolves.toBeTruthy();
  });

  it('requires the current schema version to exist', async () => {
    const c = await customer();
    await expect(
      q('INSERT INTO catalogs (customer_id, name) VALUES ($1, $2)', [
        c,
        'no version',
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps schema versions per catalog', async () => {
    const c = await customer();
    const cat = await catalog(c, 'versions');
    await expect(
      q(
        "INSERT INTO catalog_schema_versions (catalog_id, version, properties) VALUES ($1, 1, '[]')",
        [cat],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('sites and attention (3.2)', () => {
  it('rejects a duplicate URL in one catalog and accepts it in another', async () => {
    const c = await customer();
    const first = await catalog(c, 'sites-1');
    const second = await catalog(c, 'sites-2');
    await site(first, 'https://a.example/');
    await expect(site(first, 'https://a.example/')).rejects.toMatchObject({
      code: '23505',
    });
    await expect(site(second, 'https://a.example/')).resolves.toBeTruthy();
  });

  it('validates country and currency codes', async () => {
    const c = await customer();
    const cat = await catalog(c, 'codes');
    await expect(
      q(
        "INSERT INTO sites (catalog_id, url, name, country, currency) VALUES ($1, 'u', 'n', 'ar', 'ARS')",
        [cat],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('cascade-deletes attention rows with the site', async () => {
    const c = await customer();
    const cat = await catalog(c, 'attention');
    const s = await site(cat, 'https://att.example/');
    await q(
      "INSERT INTO site_attention (site_id, reason, property) VALUES ($1, 'property_pending', 'fabric')",
      [s],
    );
    await q('DELETE FROM sites WHERE id = $1', [s]);
    const { rows } = await q(
      'SELECT count(*)::int AS n FROM site_attention WHERE site_id = $1',
      [s],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('products and variants (3.3)', () => {
  it('rejects a duplicate (site, link) and accepts the same link on another site', async () => {
    const c = await customer();
    const cat = await catalog(c, 'products-1');
    const s1 = await site(cat, 'https://p1.example/');
    const s2 = await site(cat, 'https://p2.example/');
    await product(s1, 'https://p1.example/a');
    await expect(product(s1, 'https://p1.example/a')).rejects.toMatchObject({
      code: '23505',
    });
    await expect(product(s2, 'https://p1.example/a')).resolves.toBeTruthy();
  });

  it('rejects a duplicate (product, variant value) and cascades deletes', async () => {
    const c = await customer();
    const cat = await catalog(c, 'products-2');
    const s = await site(cat, 'https://v.example/');
    const p = await product(s, 'https://v.example/a');
    const insert = () =>
      q(
        "INSERT INTO product_variants (product_id, variant_value, price, available) VALUES ($1, '10', '$ 12.990,00', true)",
        [p],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });

    await q('DELETE FROM products WHERE id = $1', [p]);
    const { rows } = await q(
      'SELECT count(*)::int AS n FROM product_variants WHERE product_id = $1',
      [p],
    );
    expect(rows[0].n).toBe(0);
  });

  it('keeps timestamps as timestamptz and price as exact text', async () => {
    const { rows } = await q(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE (table_name, column_name) IN (('products','updated_at'), ('products','price'), ('product_variants','updated_at'), ('product_variants','price'))
       ORDER BY table_name, column_name`,
    );
    expect(rows).toEqual([
      {
        table_name: 'product_variants',
        column_name: 'price',
        data_type: 'text',
      },
      {
        table_name: 'product_variants',
        column_name: 'updated_at',
        data_type: 'timestamp with time zone',
      },
      { table_name: 'products', column_name: 'price', data_type: 'text' },
      {
        table_name: 'products',
        column_name: 'updated_at',
        data_type: 'timestamp with time zone',
      },
    ]);
  });

  it('removes products when their site is deleted', async () => {
    const c = await customer();
    const cat = await catalog(c, 'products-3');
    const s = await site(cat, 'https://del.example/');
    const p = await product(s, 'https://del.example/a');
    await q('DELETE FROM sites WHERE id = $1', [s]);
    const { rows } = await q(
      'SELECT count(*)::int AS n FROM products WHERE id = $1',
      [p],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('indexes (3.4)', () => {
  beforeAll(async () => {
    const c = await customer('Indexed');
    const cat = await catalog(c, 'indexed');
    const s = await site(cat, 'https://idx.example/');
    await q(
      `INSERT INTO products (site_id, name, link, attributes)
       SELECT $1, 'Remera ' || i, 'https://idx.example/' || i,
              jsonb_build_object('gender', CASE WHEN i % 2 = 0 THEN 'girls' ELSE 'boys' END, 'type', 't-shirt')
       FROM generate_series(1, 2000) AS i`,
      [s],
    );
    await q('ANALYZE products');
  });

  async function plan(sql: string): Promise<string> {
    const client = await db.pool.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const { rows } = await client.query(`EXPLAIN ${sql}`);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      client.release();
    }
  }

  it('uses the GIN index for attribute containment', async () => {
    const text = await plan(
      `SELECT id FROM products WHERE attributes @> '{"gender":"girls","type":"t-shirt"}'`,
    );
    expect(text).toContain('products_attributes_gin_idx');
  });

  it('uses the text-search index for name search', async () => {
    const text = await plan(
      `SELECT id FROM products WHERE to_tsvector('simple', name) @@ plainto_tsquery('simple', 'remera')`,
    );
    expect(text).toContain('products_name_fts_idx');
  });

  it('uses an index for site lookups', async () => {
    const { rows } = await q('SELECT site_id FROM products LIMIT 1');
    const text = await plan(
      `SELECT id FROM products WHERE site_id = '${rows[0].site_id}'`,
    );
    expect(text).toContain('products_site_link_key');
  });

  it('uses an index for variants by value', async () => {
    const text = await plan(
      `SELECT id FROM product_variants WHERE variant_value = '10'`,
    );
    expect(text).toContain('product_variants_value_idx');
  });
});

describe('down migration (3.5)', () => {
  it('migrates down all the way and up again, leaving a working schema', async () => {
    const scratch = await createTestDatabase();
    try {
      const tables = async () =>
        (
          await scratch.pool.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'pgmigrations' ORDER BY 1",
          )
        ).rows.map((r) => r.table_name);

      const before = await tables();
      expect(before).toEqual([
        'catalog_schema_versions',
        'catalogs',
        'customers',
        'discovery_attempts',
        'product_variants',
        'products',
        'scrape_runs',
        'site_activations',
        'site_active_specs',
        'site_attention',
        'site_schedules',
        'site_spec_versions',
        'sites',
      ]);

      await migrate(scratch.url, 'down', Infinity);
      expect(await tables()).toEqual([]);

      await migrate(scratch.url, 'up');
      expect(await tables()).toEqual(before);

      const { rows } = await scratch.pool.query(
        "INSERT INTO customers (name) VALUES ('after') RETURNING id",
      );
      expect(rows[0].id).toBeTruthy();
    } finally {
      await scratch.close();
    }
  });
});
