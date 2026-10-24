import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../../database/database.module.js';
import { hasPgCode, UNIQUE_VIOLATION } from '../../database/transaction.js';
import { NotFoundError } from '../../catalog/errors.js';
import {
  AttemptContext,
  DiscoveryAttempt,
  DiscoveryFailureReason,
  DiscoveryMode,
  SchemaSnapshot,
  Usage,
} from './types.js';

const COLUMNS = `a.id, a.site_id, a.mode, a.target_properties, a.guidance, a.base_version, a.schema_version,
  a.status, a.reason, a.detail, a.spec_version, a.usage, a.evidence_key, a.requested_at, a.started_at, a.finished_at`;

export interface NewAttempt {
  siteId: string;
  mode: DiscoveryMode;
  targetProperties: string[];
  guidance: string | null;
  baseVersion: number | null;
  snapshot: SchemaSnapshot;
}

export interface SiteForDiscovery {
  siteId: string;
  customerId: string;
  catalogId: string;
  url: string;
  snapshot: SchemaSnapshot;
}

@Injectable()
export class AttemptsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Site, owner and the schema as it stands now, for internal request handling. */
  async siteForDiscovery(siteId: string): Promise<SiteForDiscovery | null> {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.url, c.id AS catalog_id, c.customer_id, c.schema_version,
              v.properties, v.variant_property
         FROM sites s JOIN catalogs c ON c.id = s.catalog_id
         JOIN catalog_schema_versions v ON v.catalog_id = c.id AND v.version = c.schema_version
        WHERE s.id = $1`,
      [siteId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      siteId: row.id,
      customerId: row.customer_id,
      catalogId: row.catalog_id,
      url: row.url,
      snapshot: {
        schemaVersion: row.schema_version,
        properties: (row.properties as Record<string, unknown>[]).map((p) => ({
          name: p.name as string,
          type: p.type as never,
          description: p.description as string,
          ...(p.example !== undefined ? { example: p.example } : {}),
          ...(p.values !== undefined ? { values: p.values as string[] } : {}),
          required: p.required === true,
        })),
        variantProperty: row.variant_property ?? null,
      },
    };
  }

  async findPending(siteId: string): Promise<DiscoveryAttempt | null> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM discovery_attempts a WHERE a.site_id = $1 AND a.status IN ('queued', 'running')`,
      [siteId],
    );
    return rows.length === 0 ? null : toAttempt(rows[0]);
  }

  /** Records a queued attempt; a concurrent pending one yields `created: false` with that attempt. */
  async createOrGetPending(
    input: NewAttempt,
  ): Promise<{ attempt: DiscoveryAttempt; created: boolean }> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO discovery_attempts
           (site_id, mode, target_properties, guidance, base_version, schema_version, schema_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, site_id, mode, target_properties, guidance, base_version, schema_version,
                   status, reason, detail, spec_version, usage, evidence_key, requested_at, started_at, finished_at`,
        [
          input.siteId,
          input.mode,
          input.targetProperties,
          input.guidance,
          input.baseVersion,
          input.snapshot.schemaVersion,
          JSON.stringify(input.snapshot),
        ],
      );
      return { attempt: toAttempt(rows[0]), created: true };
    } catch (error) {
      if (!hasPgCode(error, UNIQUE_VIOLATION)) throw error;
      const existing = await this.findPending(input.siteId);
      if (!existing) throw error;
      return { attempt: existing, created: false };
    }
  }

  async get(customerId: string, attemptId: string): Promise<DiscoveryAttempt> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM discovery_attempts a
         JOIN sites s ON s.id = a.site_id JOIN catalogs c ON c.id = s.catalog_id
        WHERE a.id = $1 AND c.customer_id = $2`,
      [attemptId, customerId],
    );
    if (rows.length === 0) throw new NotFoundError('discovery attempt');
    return toAttempt(rows[0]);
  }

  async getContext(attemptId: string): Promise<AttemptContext | null> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS}, a.schema_snapshot, c.customer_id, c.id AS catalog_id
         FROM discovery_attempts a JOIN sites s ON s.id = a.site_id JOIN catalogs c ON c.id = s.catalog_id
        WHERE a.id = $1`,
      [attemptId],
    );
    if (rows.length === 0) return null;
    return {
      ...toAttempt(rows[0]),
      customerId: rows[0].customer_id,
      catalogId: rows[0].catalog_id,
      snapshot: rows[0].schema_snapshot as SchemaSnapshot,
    };
  }

  async markRunning(attemptId: string): Promise<void> {
    await this.pool.query(
      `UPDATE discovery_attempts SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'`,
      [attemptId],
    );
  }

  async markFailed(
    attemptId: string,
    outcome: {
      reason: DiscoveryFailureReason;
      detail?: string;
      usage?: Usage;
      evidenceKey?: string;
    },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE discovery_attempts
          SET status = 'failed', reason = $2, detail = $3, usage = $4, evidence_key = $5, finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [
        attemptId,
        outcome.reason,
        outcome.detail ?? null,
        outcome.usage ? JSON.stringify(outcome.usage) : null,
        outcome.evidenceKey ?? null,
      ],
    );
  }

  /** Latest scrape's failing properties for the site, used as repair defaults. */
  async latestFailingProperties(siteId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT failing_properties FROM scrape_runs
        WHERE site_id = $1 AND mode = 'production' AND status IN ('succeeded', 'failed')
        ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
      [siteId],
    );
    return rows.length === 0 ? [] : (rows[0].failing_properties as string[]);
  }
}

function toAttempt(row: Record<string, unknown>): DiscoveryAttempt {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    mode: row.mode as DiscoveryMode,
    targetProperties: row.target_properties as string[],
    guidance: (row.guidance as string | null) ?? null,
    baseVersion: (row.base_version as number | null) ?? null,
    schemaVersion: row.schema_version as number,
    status: row.status as DiscoveryAttempt['status'],
    reason: (row.reason as DiscoveryFailureReason | null) ?? null,
    detail: (row.detail as string | null) ?? null,
    specVersion: (row.spec_version as number | null) ?? null,
    usage: (row.usage as Usage | null) ?? null,
    evidenceKey: (row.evidence_key as string | null) ?? null,
    requestedAt: row.requested_at as Date,
    startedAt: (row.started_at as Date | null) ?? null,
    finishedAt: (row.finished_at as Date | null) ?? null,
  };
}
