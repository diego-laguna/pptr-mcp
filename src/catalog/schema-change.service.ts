import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';
import { withTransaction } from '../database/transaction.js';
import {
  NotFoundError,
  SchemaChangeRejectedError,
  ValidationFailedError,
} from './errors.js';
import { SchemaOperation } from './schema/operations.js';
import { CatalogSchema, variantPropertyOf } from './schema/property-types.js';
import { planSchemaChange } from './schema/schema-planner.js';

export interface AppliedSchemaChange {
  /** The catalog's current schema version after the change. */
  schemaVersion: number;
  /** False when the edits were applied in place (description, example, filterable). */
  versionChanged: boolean;
  schema: CatalogSchema;
  /** `property_pending` markers created (one per site per added property). */
  markersCreated: number;
}

@Injectable()
export class SchemaChangeService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /**
   * Applies explicit operations to one catalog's schema in a single
   * transaction: new version, stored-attribute migration and site markers all
   * happen, or nothing does. The catalog row lock serializes concurrent changes.
   */
  async apply(
    customerId: string,
    catalogId: string,
    operations: SchemaOperation[],
  ): Promise<AppliedSchemaChange> {
    if (!Array.isArray(operations)) {
      throw new ValidationFailedError('operations must be an array', [
        {
          path: 'operations',
          code: 'invalid_operations',
          message: 'must be an array',
        },
      ]);
    }

    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT c.schema_version FROM catalogs c
         WHERE c.id = $1 AND c.customer_id = $2 FOR UPDATE`,
        [catalogId, customerId],
      );
      if (locked.rows.length === 0) throw new NotFoundError('catalog');
      const currentVersion: number = locked.rows[0].schema_version;

      const current = await client.query(
        `SELECT properties, changes FROM catalog_schema_versions
         WHERE catalog_id = $1 AND version = $2`,
        [catalogId, currentVersion],
      );
      const currentSchema: CatalogSchema = {
        properties: current.rows[0].properties,
      };

      const hasProducts = (
        await client.query(
          `SELECT EXISTS (
             SELECT 1 FROM products p JOIN sites s ON s.id = p.site_id WHERE s.catalog_id = $1
           ) AS present`,
          [catalogId],
        )
      ).rows[0].present as boolean;

      const plan = planSchemaChange(currentSchema, operations, { hasProducts });
      if (!plan.ok) {
        throw new SchemaChangeRejectedError(
          `schema change rejected: ${plan.errors.map((e) => `${e.code} (${e.message})`).join('; ')}`,
          plan.errors,
        );
      }

      for (const { property, value } of plan.effects.removedEnumValues) {
        const inUse = await client.query(
          `SELECT 1 FROM products p JOIN sites s ON s.id = p.site_id
           WHERE s.catalog_id = $1 AND p.attributes ->> $2 = $3 LIMIT 1`,
          [catalogId, property, value],
        );
        if (inUse.rows.length > 0) {
          throw new SchemaChangeRejectedError(
            `cannot remove "${value}" from "${property}": stored products use it`,
            [
              {
                path: `properties.${property}`,
                code: 'enum_value_in_use',
                message: `stored products use "${value}"`,
              },
            ],
          );
        }
      }

      for (const migration of plan.effects.attributeMigrations) {
        if (migration.kind === 'rename') {
          await client.query(
            `UPDATE products p
             SET attributes = (p.attributes - $2::text) || jsonb_build_object($3::text, p.attributes -> $2::text)
             FROM sites s
             WHERE p.site_id = s.id AND s.catalog_id = $1 AND p.attributes ? $2::text`,
            [catalogId, migration.from, migration.to],
          );
          // A pending marker follows its property to the new name.
          await client.query(
            `UPDATE site_attention a SET property = $3
             FROM sites s
             WHERE a.site_id = s.id AND s.catalog_id = $1 AND a.property = $2
               AND a.reason = 'property_pending' AND a.cleared_at IS NULL`,
            [catalogId, migration.from, migration.to],
          );
        } else {
          await client.query(
            `UPDATE products p SET attributes = p.attributes - $2::text
             FROM sites s
             WHERE p.site_id = s.id AND s.catalog_id = $1 AND p.attributes ? $2::text`,
            [catalogId, migration.from],
          );
          // A pending marker for a property that no longer exists is moot.
          await client.query(
            `UPDATE site_attention a SET cleared_at = now()
             FROM sites s
             WHERE a.site_id = s.id AND s.catalog_id = $1 AND a.property = $2
               AND a.reason = 'property_pending' AND a.cleared_at IS NULL`,
            [catalogId, migration.from],
          );
        }
      }

      const variantProperty = variantPropertyOf(plan.schema)?.name ?? null;
      let schemaVersion = currentVersion;
      if (plan.newVersion) {
        schemaVersion = currentVersion + 1;
        await client.query(
          `INSERT INTO catalog_schema_versions (catalog_id, version, properties, variant_property, changes)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            catalogId,
            schemaVersion,
            JSON.stringify(plan.schema.properties),
            variantProperty,
            JSON.stringify(plan.changes),
          ],
        );
        await client.query(
          'UPDATE catalogs SET schema_version = $2 WHERE id = $1',
          [catalogId, schemaVersion],
        );
      } else {
        // In-place edits keep the version; the operations are appended for audit.
        await client.query(
          `UPDATE catalog_schema_versions
           SET properties = $3, changes = changes || $4::jsonb
           WHERE catalog_id = $1 AND version = $2`,
          [
            catalogId,
            currentVersion,
            JSON.stringify(plan.schema.properties),
            JSON.stringify(plan.changes),
          ],
        );
      }

      let markersCreated = 0;
      for (const property of plan.effects.addedProperties) {
        const inserted = await client.query(
          `INSERT INTO site_attention (site_id, reason, property)
           SELECT s.id, 'property_pending', $2 FROM sites s WHERE s.catalog_id = $1`,
          [catalogId, property],
        );
        markersCreated += inserted.rowCount ?? 0;
      }

      return {
        schemaVersion,
        versionChanged: plan.newVersion,
        schema: plan.schema,
        markersCreated,
      };
    });
  }
}
