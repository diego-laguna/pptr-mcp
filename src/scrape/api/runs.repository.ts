import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../../database/database.module.js';
import { hasPgCode, UNIQUE_VIOLATION } from '../../database/transaction.js';
import { NotFoundError } from '../../catalog/errors.js';
import { FailureReason, ScrapeMode } from '../contracts/messages.js';
import { RunContext, ScrapeRun } from './types.js';

const COLUMNS = `r.id, r.site_id, r.mode, r.spec_version, r.schema_version, r.status, r.reason,
  r.detail, r.item_count, r.page_count, r.result_key, r.requested_at, r.started_at, r.finished_at`;

export interface NewRun {
  siteId: string;
  mode: ScrapeMode;
  specVersion: number;
  schemaVersion: number;
}

@Injectable()
export class RunsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /**
   * Records a queued run, or returns the pending one for the same site and
   * mode (and spec version for previews). `created` tells the caller whether
   * a message must be enqueued.
   */
  async createOrGetPending(
    customerId: string,
    input: NewRun,
  ): Promise<{ run: ScrapeRun; created: boolean }> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO scrape_runs (site_id, mode, spec_version, schema_version)
         SELECT s.id, $3, $4, $5 FROM sites s JOIN catalogs c ON c.id = s.catalog_id
          WHERE s.id = $1 AND c.customer_id = $2
         RETURNING id, site_id, mode, spec_version, schema_version, status, reason, detail,
                   item_count, page_count, result_key, requested_at, started_at, finished_at`,
        [
          input.siteId,
          customerId,
          input.mode,
          input.specVersion,
          input.schemaVersion,
        ],
      );
      if (rows.length === 0) throw new NotFoundError('site');
      return { run: toRun(rows[0]), created: true };
    } catch (error) {
      if (!hasPgCode(error, UNIQUE_VIOLATION)) throw error;
      const { rows } = await this.pool.query(
        `SELECT ${COLUMNS} FROM scrape_runs r
          WHERE r.site_id = $1 AND r.mode = $2 AND r.status IN ('queued', 'running')
            AND ($2 = 'production' OR r.spec_version = $3)
          LIMIT 1`,
        [input.siteId, input.mode, input.specVersion],
      );
      if (rows.length === 0) throw error; // the pending run finished in between; the caller may retry
      return { run: toRun(rows[0]), created: false };
    }
  }

  async get(customerId: string, runId: string): Promise<ScrapeRun> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM scrape_runs r
         JOIN sites s ON s.id = r.site_id JOIN catalogs c ON c.id = s.catalog_id
        WHERE r.id = $1 AND c.customer_id = $2`,
      [runId, customerId],
    );
    if (rows.length === 0) throw new NotFoundError('run');
    return toRun(rows[0]);
  }

  /** Internal lookup by id for result handling; never exposed to customers. */
  async getContext(runId: string): Promise<RunContext | null> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS}, c.customer_id, c.id AS catalog_id
         FROM scrape_runs r JOIN sites s ON s.id = r.site_id JOIN catalogs c ON c.id = s.catalog_id
        WHERE r.id = $1`,
      [runId],
    );
    if (rows.length === 0) return null;
    return {
      ...toRun(rows[0]),
      customerId: rows[0].customer_id,
      catalogId: rows[0].catalog_id,
    };
  }

  async markRunning(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scrape_runs SET status = 'running', started_at = now()
        WHERE id = $1 AND status = 'queued'`,
      [runId],
    );
  }

  async markSucceeded(
    runId: string,
    outcome: { itemCount: number; pageCount: number; resultKey: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE scrape_runs
          SET status = 'succeeded', item_count = $2, page_count = $3, result_key = $4,
              started_at = COALESCE(started_at, now()), finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [runId, outcome.itemCount, outcome.pageCount, outcome.resultKey],
    );
  }

  async markFailed(
    runId: string,
    outcome: {
      reason: FailureReason;
      detail?: string;
      itemCount?: number;
      pageCount?: number;
      resultKey?: string;
    },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE scrape_runs
          SET status = 'failed', reason = $2, detail = $3, item_count = $4, page_count = $5,
              result_key = $6, finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [
        runId,
        outcome.reason,
        outcome.detail ?? null,
        outcome.itemCount ?? null,
        outcome.pageCount ?? null,
        outcome.resultKey ?? null,
      ],
    );
  }

  /** Item count of the site's most recent complete production run, if any. */
  async previousCompleteItemCount(siteId: string): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT item_count FROM scrape_runs
        WHERE site_id = $1 AND mode = 'production' AND status = 'succeeded'
        ORDER BY finished_at DESC LIMIT 1`,
      [siteId],
    );
    return rows.length === 0 ? null : (rows[0].item_count as number);
  }

  /** Ownership and pinned schema for a site, for internal request handling. */
  async siteContext(siteId: string): Promise<{
    siteId: string;
    customerId: string;
    catalogId: string;
    schemaVersion: number;
    schema: { properties: string[]; variantProperty: string | null };
  } | null> {
    const { rows } = await this.pool.query(
      `SELECT s.id, c.customer_id, c.id AS catalog_id, c.schema_version,
              v.properties, v.variant_property
         FROM sites s JOIN catalogs c ON c.id = s.catalog_id
         JOIN catalog_schema_versions v ON v.catalog_id = c.id AND v.version = c.schema_version
        WHERE s.id = $1`,
      [siteId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const properties = row.properties as { name: string }[];
    return {
      siteId: row.id,
      customerId: row.customer_id,
      catalogId: row.catalog_id,
      schemaVersion: row.schema_version,
      schema: {
        properties: properties.map((p) => p.name),
        variantProperty: row.variant_property ?? null,
      },
    };
  }

  /** Current schema version of the catalog that owns the site. */
  async currentSchemaVersion(siteId: string): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT c.schema_version FROM sites s JOIN catalogs c ON c.id = s.catalog_id WHERE s.id = $1`,
      [siteId],
    );
    return rows.length === 0 ? null : (rows[0].schema_version as number);
  }
}

function toRun(row: Record<string, unknown>): ScrapeRun {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    mode: row.mode as ScrapeMode,
    specVersion: row.spec_version as number,
    schemaVersion: row.schema_version as number,
    status: row.status as ScrapeRun['status'],
    reason: (row.reason as FailureReason | null) ?? null,
    detail: (row.detail as string | null) ?? null,
    itemCount: (row.item_count as number | null) ?? null,
    pageCount: (row.page_count as number | null) ?? null,
    resultKey: (row.result_key as string | null) ?? null,
    requestedAt: row.requested_at as Date,
    startedAt: (row.started_at as Date | null) ?? null,
    finishedAt: (row.finished_at as Date | null) ?? null,
  };
}
