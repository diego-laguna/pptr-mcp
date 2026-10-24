import pg from 'pg';
import { ActiveSpecResolver } from '../scrape/api/active-spec.js';

/** The site's active version from PostgreSQL; null while a site has never been activated. */
export class DbActiveSpecResolver implements ActiveSpecResolver {
  constructor(private readonly pool: pg.Pool) {}

  async resolve(customerId: string, siteId: string): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT a.version FROM site_active_specs a
         JOIN sites s ON s.id = a.site_id JOIN catalogs c ON c.id = s.catalog_id
        WHERE a.site_id = $1 AND c.customer_id = $2`,
      [siteId, customerId],
    );
    return rows.length === 0 ? null : (rows[0].version as number);
  }
}
