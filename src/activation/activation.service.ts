import { Injectable, Logger } from '@nestjs/common';
import pg from 'pg';
import { NotFoundError } from '../catalog/errors.js';
import { withTransaction } from '../database/transaction.js';
import { SpecStore } from '../scrape/spec/spec-store.js';
import { specKey } from '../scrape/storage/keys.js';
import { SelectorSpec } from '../scrape/spec/selector-spec.js';
import {
  assertCadenceAllowed,
  Cadence,
  DEFAULT_MIN_INTERVAL_MINUTES,
  InvalidCadenceError,
  parseCadence,
} from './cadence.js';
import {
  ActivationConflictError,
  ActivationValidationError,
} from './errors.js';
import { SchedulePort } from './schedule-port.js';

export interface ActivationRequest {
  customerId: string;
  siteId: string;
  version: number;
  /** The version currently active, or null for a first activation. */
  expectedCurrent: number | null;
  acknowledge?: string[];
  cadence?: { expression?: unknown; timezone?: unknown };
  approvedBy?: string | null;
}

export interface ActivationRecord {
  id: string;
  siteId: string;
  version: number;
  replacedVersion: number | null;
  previewRunId: string | null;
  acknowledgedProperties: string[];
  approvedBy: string | null;
  activatedAt: Date;
}

export interface ActivationDeps {
  pool: pg.Pool;
  specs: SpecStore;
  schedules: SchedulePort;
  /** Requests a production scrape through the normal refresh path. */
  requestScrape(siteId: string): Promise<unknown>;
  minIntervalMinutes?: number;
  logger?: Pick<Logger, 'warn'>;
}

const toRecord = (r: Record<string, unknown>): ActivationRecord => ({
  id: r.id as string,
  siteId: r.site_id as string,
  version: r.version as number,
  replacedVersion: (r.replaced_version as number | null) ?? null,
  previewRunId: (r.preview_run_id as string | null) ?? null,
  acknowledgedProperties: r.acknowledged_properties as string[],
  approvedBy: (r.approved_by as string | null) ?? null,
  activatedAt: r.activated_at as Date,
});

/** Properties of the current schema that a spec binds, the variant property included. */
export function boundByVersion(
  spec: SelectorSpec,
  variantProperty: string | null,
): string[] {
  const bound = Object.keys(spec.properties);
  if (spec.variants && variantProperty) bound.push(variantProperty);
  return bound;
}

@Injectable()
export class ActivationService {
  constructor(private readonly deps: ActivationDeps) {}

  private get minInterval() {
    return this.deps.minIntervalMinutes ?? DEFAULT_MIN_INTERVAL_MINUTES;
  }

  /** The single place the active pointer moves. Returns the activation record (the existing one for a repeat). */
  async activate(
    request: ActivationRequest,
  ): Promise<{ record: ActivationRecord; changed: boolean }> {
    const { pool, specs } = this.deps;
    const { customerId, siteId, version } = request;

    // Spec versions are immutable, so loading outside the transaction is safe.
    const owned = await pool.query(
      `SELECT 1 FROM sites s JOIN catalogs c ON c.id = s.catalog_id WHERE s.id = $1 AND c.customer_id = $2`,
      [siteId, customerId],
    );
    if (owned.rowCount === 0) throw new NotFoundError('site');
    const versionRow = await pool.query(
      'SELECT discarded_at FROM site_spec_versions WHERE site_id = $1 AND version = $2',
      [siteId, version],
    );
    if (versionRow.rowCount === 0) throw new NotFoundError('spec version');
    const spec = await specs.load(specKey(customerId, siteId, version));

    let cadence: Cadence | null = null;
    const result = await withTransaction(pool, async (client) => {
      // Serializes every activation of the site, including a first one that has no pointer row yet.
      await client.query('SELECT 1 FROM sites WHERE id = $1 FOR UPDATE', [
        siteId,
      ]);
      const current = await client.query(
        'SELECT version FROM site_active_specs WHERE site_id = $1',
        [siteId],
      );
      const currentVersion =
        (current.rows[0]?.version as number | undefined) ?? null;

      if (currentVersion === version) {
        const last = await client.query(
          'SELECT * FROM site_activations WHERE site_id = $1 AND version = $2 ORDER BY activated_at DESC LIMIT 1',
          [siteId, version],
        );
        return { record: toRecord(last.rows[0]), changed: false, first: false };
      }
      if (currentVersion !== request.expectedCurrent)
        throw new ActivationConflictError(
          'stale_activation',
          `the active version is ${currentVersion ?? 'none'}, not ${request.expectedCurrent ?? 'none'}`,
        );

      const fresh = await client.query(
        'SELECT discarded_at FROM site_spec_versions WHERE site_id = $1 AND version = $2',
        [siteId, version],
      );
      if (fresh.rows[0].discarded_at)
        throw new ActivationConflictError(
          'discarded',
          `version ${version} was discarded`,
        );

      // A preview of this exact version, unless the version was live before (rollback).
      const wasActive = await client.query(
        'SELECT 1 FROM site_activations WHERE site_id = $1 AND version = $2 LIMIT 1',
        [siteId, version],
      );
      let previewRunId: string | null = null;
      if (wasActive.rowCount === 0) {
        const preview = await client.query(
          `SELECT id FROM scrape_runs WHERE site_id = $1 AND mode = 'preview' AND spec_version = $2 AND status = 'succeeded'
            ORDER BY finished_at DESC LIMIT 1`,
          [siteId, version],
        );
        if (preview.rowCount === 0)
          throw new ActivationConflictError(
            'preview_required',
            `version ${version} has no completed preview`,
          );
        previewRunId = preview.rows[0].id;
      }

      const schemaRow = await client.query(
        `SELECT v.properties, v.variant_property FROM sites s JOIN catalogs c ON c.id = s.catalog_id
           JOIN catalog_schema_versions v ON v.catalog_id = c.id AND v.version = c.schema_version WHERE s.id = $1`,
        [siteId],
      );
      const properties = schemaRow.rows[0].properties as {
        name: string;
        required?: boolean;
      }[];
      const names = new Set(properties.map((p) => p.name));
      const bound = boundByVersion(
        spec,
        schemaRow.rows[0].variant_property as string | null,
      );
      const missing = bound.filter((n) => !names.has(n));
      if (missing.length > 0)
        throw new ActivationConflictError(
          'schema_changed',
          `no longer in the schema: ${missing.join(', ')}`,
        );

      const unboundRequired = properties
        .filter((p) => p.required === true && !bound.includes(p.name))
        .map((p) => p.name);
      const acknowledged = [...new Set(request.acknowledge ?? [])];
      const invalid = acknowledged.filter((n) => !unboundRequired.includes(n));
      if (invalid.length > 0)
        throw new ActivationValidationError(
          'invalid_acknowledgment',
          `not unbound required properties: ${invalid.join(', ')}`,
          invalid,
        );
      const unacknowledged = unboundRequired.filter(
        (n) => !acknowledged.includes(n),
      );
      if (unacknowledged.length > 0)
        throw new ActivationValidationError(
          'unacknowledged_properties',
          `required properties left unbound must be acknowledged: ${unacknowledged.join(', ')}`,
          unacknowledged,
        );

      const first = currentVersion === null;
      if (first) {
        if (request.cadence === undefined || request.cadence === null)
          throw new ActivationValidationError(
            'cadence_required',
            'a first activation needs the cadence the customer chose',
          );
        try {
          cadence = parseCadence(request.cadence);
          assertCadenceAllowed(cadence, this.minInterval);
        } catch (error) {
          if (error instanceof InvalidCadenceError)
            throw new ActivationValidationError(
              'invalid_cadence',
              error.message,
            );
          throw error;
        }
        await client.query(
          `INSERT INTO site_schedules (site_id, expression, timezone) VALUES ($1, $2, $3)
           ON CONFLICT (site_id) DO UPDATE SET expression = EXCLUDED.expression, timezone = EXCLUDED.timezone, updated_at = now()`,
          [siteId, cadence.expression, cadence.timezone],
        );
      }

      await client.query(
        `INSERT INTO site_active_specs (site_id, version) VALUES ($1, $2)
         ON CONFLICT (site_id) DO UPDATE SET version = EXCLUDED.version, activated_at = now()`,
        [siteId, version],
      );
      // Only the properties this version binds are resolved; the rest stay pending.
      await client.query(
        `UPDATE site_attention SET cleared_at = now()
          WHERE site_id = $1 AND reason = 'property_pending' AND cleared_at IS NULL AND property = ANY($2)`,
        [siteId, bound],
      );
      const inserted = await client.query(
        `INSERT INTO site_activations (site_id, version, replaced_version, preview_run_id, acknowledged_properties, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          siteId,
          version,
          currentVersion,
          previewRunId,
          acknowledged,
          request.approvedBy ?? null,
        ],
      );
      return { record: toRecord(inserted.rows[0]), changed: true, first };
    });

    if (result.changed && result.first && cadence)
      await this.startSite(siteId, cadence);
    return { record: result.record, changed: result.changed };
  }

  /** After the pointer committed: create the schedule and request one scrape. Failures are repaired later or retried by the caller. */
  private async startSite(siteId: string, cadence: Cadence): Promise<void> {
    try {
      await this.deps.schedules.upsert(siteId, cadence);
    } catch (error) {
      this.deps.logger?.warn(
        `schedule for ${siteId} could not be created now; reconciliation will repair it: ${(error as Error).message}`,
      );
    }
    try {
      await this.deps.requestScrape(siteId);
    } catch (error) {
      this.deps.logger?.warn(
        `first scrape for ${siteId} could not be requested: ${(error as Error).message}`,
      );
    }
  }

  async history(
    customerId: string,
    siteId: string,
  ): Promise<ActivationRecord[]> {
    await this.assertOwned(customerId, siteId);
    const { rows } = await this.deps.pool.query(
      'SELECT * FROM site_activations WHERE site_id = $1 ORDER BY activated_at DESC, id',
      [siteId],
    );
    return rows.map(toRecord);
  }

  async activeVersion(
    customerId: string,
    siteId: string,
  ): Promise<number | null> {
    await this.assertOwned(customerId, siteId);
    const { rows } = await this.deps.pool.query(
      'SELECT version FROM site_active_specs WHERE site_id = $1',
      [siteId],
    );
    return rows[0]?.version ?? null;
  }

  /** Marks a stored version discarded; the active version cannot be discarded. */
  async discard(
    customerId: string,
    siteId: string,
    version: number,
  ): Promise<void> {
    await this.assertOwned(customerId, siteId);
    await withTransaction(this.deps.pool, async (client) => {
      await client.query('SELECT 1 FROM sites WHERE id = $1 FOR UPDATE', [
        siteId,
      ]);
      const exists = await client.query(
        'SELECT 1 FROM site_spec_versions WHERE site_id = $1 AND version = $2',
        [siteId, version],
      );
      if (exists.rowCount === 0) throw new NotFoundError('spec version');
      const active = await client.query(
        'SELECT version FROM site_active_specs WHERE site_id = $1',
        [siteId],
      );
      if (active.rows[0]?.version === version)
        throw new ActivationConflictError(
          'active_version',
          'the active version cannot be discarded',
        );
      await client.query(
        'UPDATE site_spec_versions SET discarded_at = coalesce(discarded_at, now()) WHERE site_id = $1 AND version = $2',
        [siteId, version],
      );
    });
  }

  private async assertOwned(customerId: string, siteId: string): Promise<void> {
    const { rowCount } = await this.deps.pool.query(
      `SELECT 1 FROM sites s JOIN catalogs c ON c.id = s.catalog_id WHERE s.id = $1 AND c.customer_id = $2`,
      [siteId, customerId],
    );
    if (rowCount === 0) throw new NotFoundError('site');
  }
}
