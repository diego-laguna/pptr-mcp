import pg from 'pg';
import { ObjectStore } from '../scrape/storage/object-store.js';

/** The interim pointer object written before the database pointer existed. */
const legacyKey = (customerId: string, siteId: string) =>
  `customers/${customerId}/sites/${siteId}/specs/active.json`;

/**
 * One-off: creates `site_active_specs` rows from legacy `active.json` objects
 * (the development customer's sites). Existing rows are left alone, so it is
 * safe to run again. After it, the objects are no longer read by anything.
 */
export async function seedPointersFromActiveJson(
  pool: pg.Pool,
  objects: ObjectStore,
): Promise<{ created: number; skipped: number }> {
  const { rows } = await pool.query(
    'SELECT s.id AS site_id, c.customer_id FROM sites s JOIN catalogs c ON c.id = s.catalog_id',
  );
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const body = await objects.get(legacyKey(row.customer_id, row.site_id));
    let version: unknown;
    try {
      version =
        body === null
          ? undefined
          : (JSON.parse(body) as { version?: unknown }).version;
    } catch {
      version = undefined;
    }
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 1
    )
      continue;
    const result = await pool.query(
      'INSERT INTO site_active_specs (site_id, version) VALUES ($1, $2) ON CONFLICT (site_id) DO NOTHING',
      [row.site_id, version],
    );
    if (result.rowCount === 1) created++;
    else skipped++;
  }
  return { created, skipped };
}
