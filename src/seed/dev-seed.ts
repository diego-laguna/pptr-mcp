import pg from 'pg';
import { withTransaction } from '../database/transaction.js';
import { variantPropertyOf } from '../catalog/schema/property-types.js';
import { assertValidSchema } from '../catalog/schema/schema-validator.js';

/** Fixed so that applying the seed twice finds the same customer. */
export const DEV_CUSTOMER_ID = '00000000-0000-4000-8000-000000000001';
export const DEV_CUSTOMER_NAME = 'Development customer';
export const DEV_CATALOG_NAME = 'Kids clothing (Argentina)';

export const DEV_SITES = [
  { name: 'Grisino', url: 'https://www.grisino.com/' },
  { name: 'Cheeky', url: 'https://www.cheeky.com.ar/' },
  { name: 'Naranjo', url: 'https://www.naranjo.com.ar/' },
  { name: 'Mimo', url: 'https://www.mimo.com.ar/' },
  { name: 'Baby Cottons', url: 'https://www.babycottons.com.ar/' },
] as const;

export const DEV_CLOTHING_SCHEMA = assertValidSchema({
  properties: [
    {
      name: 'gender',
      type: 'enum',
      description: 'Who the garment is for',
      values: ['girls', 'boys', 'unisex'],
      example: 'girls',
      filterable: true,
    },
    {
      name: 'type',
      type: 'string',
      description: 'Kind of garment, for example t-shirt, pants or dress',
      example: 't-shirt',
      filterable: true,
    },
    {
      name: 'size',
      type: 'string',
      description: 'Size the garment is offered in, for example 10, S or 3-6m',
      example: '10',
      variant: true,
    },
    {
      name: 'unit_system',
      type: 'string',
      description:
        'How the size is expressed, for example years, months or letters',
      example: 'years',
    },
  ],
});

export interface DevSeedResult {
  customerId: string;
  catalogId: string;
  sitesCreated: number;
}

export function isDevSeedEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SEED_DEV_DATA?.trim().toLowerCase() === 'true';
}

/**
 * Creates the development customer, its clothing catalog and the five PRD
 * sites. Safe to apply repeatedly: existing rows and identifiers are kept.
 */
export async function applyDevSeed(pool: pg.Pool): Promise<DevSeedResult> {
  return withTransaction(pool, async (client) => {
    await client.query(
      'INSERT INTO customers (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [DEV_CUSTOMER_ID, DEV_CUSTOMER_NAME],
    );

    let catalogId: string;
    const existing = await client.query(
      'SELECT id FROM catalogs WHERE customer_id = $1 AND name = $2',
      [DEV_CUSTOMER_ID, DEV_CATALOG_NAME],
    );
    if (existing.rows.length > 0) {
      catalogId = existing.rows[0].id;
    } else {
      const inserted = await client.query(
        'INSERT INTO catalogs (customer_id, name) VALUES ($1, $2) RETURNING id',
        [DEV_CUSTOMER_ID, DEV_CATALOG_NAME],
      );
      catalogId = inserted.rows[0].id;
      await client.query(
        `INSERT INTO catalog_schema_versions (catalog_id, version, properties, variant_property)
         VALUES ($1, 1, $2, $3)`,
        [
          catalogId,
          JSON.stringify(DEV_CLOTHING_SCHEMA.properties),
          variantPropertyOf(DEV_CLOTHING_SCHEMA)?.name ?? null,
        ],
      );
    }

    let sitesCreated = 0;
    for (const site of DEV_SITES) {
      const result = await client.query(
        `INSERT INTO sites (catalog_id, url, name, country, currency)
         VALUES ($1, $2, $3, 'AR', 'ARS') ON CONFLICT (catalog_id, url) DO NOTHING`,
        [catalogId, site.url, site.name],
      );
      sitesCreated += result.rowCount ?? 0;
    }

    return { customerId: DEV_CUSTOMER_ID, catalogId, sitesCreated };
  });
}

/** Applies the seed only when SEED_DEV_DATA=true; returns whether it ran. */
export async function runDevSeedIfEnabled(
  pool: pg.Pool,
  env: Record<string, string | undefined> = process.env,
): Promise<DevSeedResult | undefined> {
  if (!isDevSeedEnabled(env)) return undefined;
  return applyDevSeed(pool);
}
