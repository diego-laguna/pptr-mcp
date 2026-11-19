import { Injectable, Logger } from '@nestjs/common';
import pg from 'pg';
import { NotFoundError } from '../catalog/errors.js';
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

export interface ScheduleDeps {
  pool: pg.Pool;
  schedules: SchedulePort;
  minIntervalMinutes?: number;
  logger?: Pick<Logger, 'warn' | 'log'>;
}

/** A site's cadence: the database is the source of truth, EventBridge mirrors it. */
@Injectable()
export class ScheduleService {
  constructor(private readonly deps: ScheduleDeps) {}

  async get(customerId: string, siteId: string): Promise<Cadence | null> {
    const { rows } = await this.deps.pool.query(
      `SELECT sc.expression, sc.timezone FROM site_schedules sc
         JOIN sites s ON s.id = sc.site_id JOIN catalogs c ON c.id = s.catalog_id
        WHERE sc.site_id = $1 AND c.customer_id = $2`,
      [siteId, customerId],
    );
    if (rows.length === 0) {
      await this.assertOwned(customerId, siteId);
      return null;
    }
    return { expression: rows[0].expression, timezone: rows[0].timezone };
  }

  /** Changes only this site's cadence and schedule; requests no scrape and leaves running runs alone. */
  async change(
    customerId: string,
    siteId: string,
    input: { expression?: unknown; timezone?: unknown },
  ): Promise<Cadence> {
    await this.assertOwned(customerId, siteId);
    const active = await this.deps.pool.query(
      'SELECT 1 FROM site_active_specs WHERE site_id = $1',
      [siteId],
    );
    if (active.rowCount === 0)
      throw new ActivationConflictError(
        'no_active_spec',
        'the site has no active version',
      );
    let cadence: Cadence;
    try {
      cadence = parseCadence(input);
      assertCadenceAllowed(
        cadence,
        this.deps.minIntervalMinutes ?? DEFAULT_MIN_INTERVAL_MINUTES,
      );
    } catch (error) {
      if (error instanceof InvalidCadenceError)
        throw new ActivationValidationError('invalid_cadence', error.message);
      throw error;
    }
    await this.deps.pool.query(
      `INSERT INTO site_schedules (site_id, expression, timezone) VALUES ($1, $2, $3)
       ON CONFLICT (site_id) DO UPDATE SET expression = EXCLUDED.expression, timezone = EXCLUDED.timezone, updated_at = now()`,
      [siteId, cadence.expression, cadence.timezone],
    );
    try {
      await this.deps.schedules.upsert(siteId, cadence);
    } catch (error) {
      this.deps.logger?.warn(
        `schedule for ${siteId} will be updated by reconciliation: ${(error as Error).message}`,
      );
    }
    return cadence;
  }

  /**
   * Makes the schedules match the database: every site with an active version
   * and a stored cadence gets its schedule created or corrected, and schedules
   * of sites without a pointer are removed.
   */
  async reconcile(): Promise<{ upserted: number; removed: number }> {
    const { rows } = await this.deps.pool.query(
      `SELECT sc.site_id, sc.expression, sc.timezone FROM site_schedules sc
         JOIN site_active_specs a ON a.site_id = sc.site_id`,
    );
    const desired = new Set<string>();
    let upserted = 0;
    for (const row of rows) {
      desired.add(row.site_id);
      try {
        await this.deps.schedules.upsert(row.site_id, {
          expression: row.expression,
          timezone: row.timezone,
        });
        upserted++;
      } catch (error) {
        this.deps.logger?.warn(
          `could not reconcile the schedule of ${row.site_id}: ${(error as Error).message}`,
        );
      }
    }
    let removed = 0;
    for (const siteId of await this.deps.schedules.listSiteIds()) {
      if (desired.has(siteId)) continue;
      try {
        await this.deps.schedules.remove(siteId);
        removed++;
      } catch (error) {
        this.deps.logger?.warn(
          `could not remove the schedule of ${siteId}: ${(error as Error).message}`,
        );
      }
    }
    return { upserted, removed };
  }

  private async assertOwned(customerId: string, siteId: string): Promise<void> {
    const { rowCount } = await this.deps.pool.query(
      `SELECT 1 FROM sites s JOIN catalogs c ON c.id = s.catalog_id WHERE s.id = $1 AND c.customer_id = $2`,
      [siteId, customerId],
    );
    if (rowCount === 0) throw new NotFoundError('site');
  }
}
