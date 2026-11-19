import { Injectable } from '@nestjs/common';
import pg from 'pg';
import { NotFoundError } from '../catalog/errors.js';
import { ResultItem, RunResult } from '../scrape/contracts/messages.js';
import { SpecStore } from '../scrape/spec/spec-store.js';
import { specKey } from '../scrape/storage/keys.js';
import { ObjectStore } from '../scrape/storage/object-store.js';
import { boundByVersion } from './activation.service.js';

export interface Review {
  version: {
    siteId: string;
    version: number;
    mode: string;
    attemptId: string;
    baseVersion: number | null;
    schemaVersion: number;
    boundProperties: string[];
    discarded: boolean;
    createdAt: Date;
  };
  preview: {
    status: 'none' | 'pending' | 'failed' | 'succeeded';
    runId: string | null;
    reason: string | null;
    resultKey: string | null;
    /** The stored sample has aged out; a fresh preview can be requested. */
    expired: boolean;
    sample: ResultItem[];
  };
  evidence: unknown;
  unboundProperties: { name: string; required: boolean }[];
  activeVersion: number | null;
  readyToActivate: boolean;
}

export const REVIEW_SAMPLE_SIZE = 10;

/** Assembled on read from the version record, preview run, evidence and schema; nothing is stored for it. */
@Injectable()
export class ReviewService {
  constructor(
    private readonly deps: {
      pool: pg.Pool;
      objects: ObjectStore;
      specs: SpecStore;
    },
  ) {}

  async review(
    customerId: string,
    siteId: string,
    version: number,
  ): Promise<Review> {
    const { pool, objects, specs } = this.deps;
    const { rows } = await pool.query(
      `SELECT v.*, a.evidence_key FROM site_spec_versions v
         JOIN sites s ON s.id = v.site_id JOIN catalogs c ON c.id = s.catalog_id
         JOIN discovery_attempts a ON a.id = v.attempt_id
        WHERE v.site_id = $1 AND v.version = $2 AND c.customer_id = $3`,
      [siteId, version, customerId],
    );
    if (rows.length === 0) throw new NotFoundError('spec version');
    const v = rows[0];

    const runRow = await pool.query(
      `SELECT id, status, reason, result_key FROM scrape_runs
        WHERE site_id = $1 AND mode = 'preview' AND spec_version = $2
        ORDER BY requested_at DESC LIMIT 1`,
      [siteId, version],
    );
    const succeeded = await pool.query(
      `SELECT id, result_key FROM scrape_runs WHERE site_id = $1 AND mode = 'preview' AND spec_version = $2 AND status = 'succeeded'
        ORDER BY finished_at DESC LIMIT 1`,
      [siteId, version],
    );
    const run = succeeded.rows[0] ?? runRow.rows[0];
    let status: Review['preview']['status'] = 'none';
    if (succeeded.rowCount) status = 'succeeded';
    else if (runRow.rowCount)
      status = runRow.rows[0].status === 'failed' ? 'failed' : 'pending';

    let sample: ResultItem[] = [];
    let expired = false;
    if (status === 'succeeded' && run.result_key) {
      const body = await objects.get(run.result_key);
      if (body === null) expired = true;
      else
        sample = (JSON.parse(body) as RunResult).items.slice(
          0,
          REVIEW_SAMPLE_SIZE,
        );
    }

    const evidenceBody = v.evidence_key
      ? await objects.get(v.evidence_key)
      : null;
    const schema = await pool.query(
      `SELECT sv.properties, sv.variant_property FROM sites s JOIN catalogs c ON c.id = s.catalog_id
         JOIN catalog_schema_versions sv ON sv.catalog_id = c.id AND sv.version = c.schema_version WHERE s.id = $1`,
      [siteId],
    );
    const spec = await specs.load(specKey(customerId, siteId, version));
    const bound = boundByVersion(spec, schema.rows[0].variant_property);
    const unbound = (
      schema.rows[0].properties as { name: string; required?: boolean }[]
    )
      .filter((p) => !bound.includes(p.name))
      .map((p) => ({ name: p.name, required: p.required === true }));
    const active = await pool.query(
      'SELECT version FROM site_active_specs WHERE site_id = $1',
      [siteId],
    );

    return {
      version: {
        siteId,
        version,
        mode: v.mode,
        attemptId: v.attempt_id,
        baseVersion: v.base_version ?? null,
        schemaVersion: v.schema_version,
        boundProperties: v.bound_properties,
        discarded: v.discarded_at !== null,
        createdAt: v.created_at,
      },
      preview: {
        status,
        runId: run?.id ?? null,
        reason: status === 'failed' ? runRow.rows[0].reason : null,
        resultKey: run?.result_key ?? null,
        expired,
        sample,
      },
      evidence: evidenceBody ? JSON.parse(evidenceBody) : null,
      unboundProperties: unbound,
      activeVersion: active.rows[0]?.version ?? null,
      readyToActivate: status === 'succeeded' && v.discarded_at === null,
    };
  }
}
