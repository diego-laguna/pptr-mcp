import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';
import { hasPgCode, UNIQUE_VIOLATION } from '../database/transaction.js';
import {
  ConflictError,
  NotFoundError,
  ValidationFailedError,
} from './errors.js';
import { ValidationIssue } from './schema/property-types.js';
import { AttentionMarker, NewSite, Site } from './types.js';

const SITE_COLUMNS =
  's.id, s.catalog_id, s.url, s.name, s.country, s.currency, s.created_at';
const MARKER_COLUMNS =
  'm.id, m.site_id, m.reason, m.property, m.created_at, m.cleared_at';

/** Every method takes the customer id and joins through the owning catalog. */
@Injectable()
export class SitesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async add(
    customerId: string,
    catalogId: string,
    input: NewSite,
  ): Promise<Site> {
    assertValidSite(input);
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO sites (catalog_id, url, name, country, currency)
         SELECT c.id, $3, $4, $5, $6 FROM catalogs c WHERE c.id = $1 AND c.customer_id = $2
         RETURNING id, catalog_id, url, name, country, currency, created_at`,
        [
          catalogId,
          customerId,
          input.url.trim(),
          input.name.trim(),
          input.country,
          input.currency,
        ],
      );
      if (rows.length === 0) throw new NotFoundError('catalog');
      return toSite(rows[0]);
    } catch (error) {
      if (hasPgCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictError(
          `the catalog already has a site with URL ${input.url.trim()}`,
        );
      }
      throw error;
    }
  }

  async list(customerId: string, catalogId: string): Promise<Site[]> {
    const { rows } = await this.pool.query(
      `SELECT ${SITE_COLUMNS} FROM sites s JOIN catalogs c ON c.id = s.catalog_id
       WHERE c.id = $1 AND c.customer_id = $2 ORDER BY s.created_at, s.name`,
      [catalogId, customerId],
    );
    if (rows.length === 0) await this.assertCatalogOwned(customerId, catalogId);
    return rows.map(toSite);
  }

  async get(customerId: string, siteId: string): Promise<Site> {
    const { rows } = await this.pool.query(
      `SELECT ${SITE_COLUMNS} FROM sites s JOIN catalogs c ON c.id = s.catalog_id
       WHERE s.id = $1 AND c.customer_id = $2`,
      [siteId, customerId],
    );
    if (rows.length === 0) throw new NotFoundError('site');
    return toSite(rows[0]);
  }

  /** Deletes the site; its products, variants and markers go with it. */
  async remove(customerId: string, siteId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM sites s USING catalogs c
       WHERE s.catalog_id = c.id AND s.id = $1 AND c.customer_id = $2`,
      [siteId, customerId],
    );
    if (rowCount === 0) throw new NotFoundError('site');
  }

  async addMarker(
    customerId: string,
    siteId: string,
    reason: string,
    property?: string,
  ): Promise<AttentionMarker> {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new ValidationFailedError('a marker needs a reason', [
        {
          path: 'reason',
          code: 'missing_reason',
          message: 'a reason code is required',
        },
      ]);
    }
    const { rows } = await this.pool.query(
      `INSERT INTO site_attention (site_id, reason, property)
       SELECT s.id, $3, $4 FROM sites s JOIN catalogs c ON c.id = s.catalog_id
       WHERE s.id = $1 AND c.customer_id = $2
       RETURNING id, site_id, reason, property, created_at, cleared_at`,
      [siteId, customerId, reason.trim(), property ?? null],
    );
    if (rows.length === 0) throw new NotFoundError('site');
    return toMarker(rows[0]);
  }

  /** Clears a marker; the row stays as history. Clearing twice keeps the first time. */
  async clearMarker(
    customerId: string,
    markerId: string,
  ): Promise<AttentionMarker> {
    const { rows } = await this.pool.query(
      `UPDATE site_attention m SET cleared_at = COALESCE(m.cleared_at, now())
       FROM sites s JOIN catalogs c ON c.id = s.catalog_id
       WHERE m.id = $1 AND m.site_id = s.id AND c.customer_id = $2
       RETURNING ${MARKER_COLUMNS}`,
      [markerId, customerId],
    );
    if (rows.length === 0) throw new NotFoundError('marker');
    return toMarker(rows[0]);
  }

  async listActiveMarkers(
    customerId: string,
    siteId: string,
  ): Promise<AttentionMarker[]> {
    return this.listMarkers(customerId, siteId, true);
  }

  /** Active and cleared markers, oldest first. */
  async listMarkerHistory(
    customerId: string,
    siteId: string,
  ): Promise<AttentionMarker[]> {
    return this.listMarkers(customerId, siteId, false);
  }

  private async listMarkers(
    customerId: string,
    siteId: string,
    activeOnly: boolean,
  ): Promise<AttentionMarker[]> {
    await this.get(customerId, siteId);
    const { rows } = await this.pool.query(
      `SELECT ${MARKER_COLUMNS} FROM site_attention m
       WHERE m.site_id = $1 ${activeOnly ? 'AND m.cleared_at IS NULL' : ''}
       ORDER BY m.created_at, m.id`,
      [siteId],
    );
    return rows.map(toMarker);
  }

  private async assertCatalogOwned(
    customerId: string,
    catalogId: string,
  ): Promise<void> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM catalogs WHERE id = $1 AND customer_id = $2',
      [catalogId, customerId],
    );
    if (rowCount === 0) throw new NotFoundError('catalog');
  }
}

function assertValidSite(input: NewSite): void {
  const issues: ValidationIssue[] = [];
  let validUrl = false;
  try {
    const url = new URL(String(input.url).trim());
    validUrl = url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    validUrl = false;
  }
  if (!validUrl) {
    issues.push({
      path: 'url',
      code: 'invalid_url',
      message: 'must be an absolute http(s) URL',
    });
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    issues.push({
      path: 'name',
      code: 'missing_name',
      message: 'a name is required',
    });
  }
  if (!/^[A-Z]{2}$/.test(String(input.country))) {
    issues.push({
      path: 'country',
      code: 'invalid_country',
      message: 'must be an ISO 3166-1 alpha-2 code such as AR',
    });
  }
  if (!/^[A-Z]{3}$/.test(String(input.currency))) {
    issues.push({
      path: 'currency',
      code: 'invalid_currency',
      message: 'must be an ISO 4217 code such as ARS',
    });
  }
  if (issues.length > 0)
    throw new ValidationFailedError('invalid site', issues);
}

export function toSite(row: any): Site {
  return {
    id: row.id,
    catalogId: row.catalog_id,
    url: row.url,
    name: row.name,
    country: row.country,
    currency: row.currency,
    createdAt: row.created_at,
  };
}

export function toMarker(row: any): AttentionMarker {
  return {
    id: row.id,
    siteId: row.site_id,
    reason: row.reason,
    property: row.property,
    createdAt: row.created_at,
    clearedAt: row.cleared_at,
  };
}
