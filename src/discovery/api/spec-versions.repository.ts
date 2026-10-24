import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../../database/database.module.js';
import { NotFoundError } from '../../catalog/errors.js';
import { DiscoveryMode, SpecVersionRecord } from './types.js';

const COLUMNS = `v.site_id, v.version, v.source, v.mode, v.attempt_id, v.base_version, v.schema_version,
  v.bound_properties, v.created_at`;

@Injectable()
export class SpecVersionsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** All versions of a site, newest first; another customer's site yields "not found". */
  async list(customerId: string, siteId: string): Promise<SpecVersionRecord[]> {
    await this.assertOwned(customerId, siteId);
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM site_spec_versions v WHERE v.site_id = $1 ORDER BY v.version DESC`,
      [siteId],
    );
    return rows.map(toRecord);
  }

  async get(
    customerId: string,
    siteId: string,
    version: number,
  ): Promise<SpecVersionRecord> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM site_spec_versions v
         JOIN sites s ON s.id = v.site_id JOIN catalogs c ON c.id = s.catalog_id
        WHERE v.site_id = $1 AND v.version = $2 AND c.customer_id = $3`,
      [siteId, version, customerId],
    );
    if (rows.length === 0) throw new NotFoundError('spec version');
    return toRecord(rows[0]);
  }

  /** Internal: newest version number of a site, if any. */
  async latestVersion(siteId: string): Promise<number | null> {
    const { rows } = await this.pool.query(
      'SELECT max(version) AS v FROM site_spec_versions WHERE site_id = $1',
      [siteId],
    );
    return (rows[0].v as number | null) ?? null;
  }

  private async assertOwned(customerId: string, siteId: string): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM sites s JOIN catalogs c ON c.id = s.catalog_id WHERE s.id = $1 AND c.customer_id = $2`,
      [siteId, customerId],
    );
    if (rows.length === 0) throw new NotFoundError('site');
  }
}

function toRecord(row: Record<string, unknown>): SpecVersionRecord {
  return {
    siteId: row.site_id as string,
    version: row.version as number,
    source: 'discovery',
    mode: row.mode as DiscoveryMode,
    attemptId: row.attempt_id as string,
    baseVersion: (row.base_version as number | null) ?? null,
    schemaVersion: row.schema_version as number,
    boundProperties: row.bound_properties as string[],
    createdAt: row.created_at as Date,
  };
}
