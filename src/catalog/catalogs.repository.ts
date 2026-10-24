import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';
import {
  FOREIGN_KEY_VIOLATION,
  hasPgCode,
  UNIQUE_VIOLATION,
  withTransaction,
} from '../database/transaction.js';
import {
  ConflictError,
  NotFoundError,
  ValidationFailedError,
} from './errors.js';
import { variantPropertyOf } from './schema/property-types.js';
import { parseSchema } from './schema/schema-validator.js';
import { Catalog, CatalogWithSchema, SchemaVersion } from './types.js';

const CATALOG_COLUMNS =
  'c.id, c.customer_id, c.name, c.schema_version, c.created_at';

/** Every method takes the customer id; rows of other customers are "not found". */
@Injectable()
export class CatalogsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Creates a catalog whose initial schema becomes version 1, or nothing. */
  async create(
    customerId: string,
    name: string,
    schemaInput: unknown,
  ): Promise<CatalogWithSchema> {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ValidationFailedError('a catalog needs a name', [
        { path: 'name', code: 'missing_name', message: 'a name is required' },
      ]);
    }
    const parsed = parseSchema(schemaInput);
    if (!parsed.ok) {
      throw new ValidationFailedError('invalid initial schema', parsed.issues);
    }
    const schema = parsed.schema;
    const variantProperty = variantPropertyOf(schema)?.name ?? null;

    try {
      return await withTransaction(this.pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO catalogs (customer_id, name) VALUES ($1, $2)
           RETURNING id, customer_id, name, schema_version, created_at`,
          [customerId, name.trim()],
        );
        await client.query(
          `INSERT INTO catalog_schema_versions (catalog_id, version, properties, variant_property)
           VALUES ($1, 1, $2, $3)`,
          [rows[0].id, JSON.stringify(schema.properties), variantProperty],
        );
        return { ...toCatalog(rows[0]), schema, variantProperty };
      });
    } catch (error) {
      if (hasPgCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictError(
          `a catalog named "${name.trim()}" already exists`,
        );
      }
      if (hasPgCode(error, FOREIGN_KEY_VIOLATION)) {
        throw new NotFoundError('customer');
      }
      throw error;
    }
  }

  async list(customerId: string): Promise<Catalog[]> {
    const { rows } = await this.pool.query(
      `SELECT ${CATALOG_COLUMNS} FROM catalogs c WHERE c.customer_id = $1 ORDER BY c.created_at, c.name`,
      [customerId],
    );
    return rows.map(toCatalog);
  }

  /** The catalog with its current schema. */
  async get(customerId: string, catalogId: string): Promise<CatalogWithSchema> {
    const { rows } = await this.pool.query(
      `SELECT ${CATALOG_COLUMNS}, v.properties, v.variant_property
       FROM catalogs c
       JOIN catalog_schema_versions v
         ON v.catalog_id = c.id AND v.version = c.schema_version
       WHERE c.id = $1 AND c.customer_id = $2`,
      [catalogId, customerId],
    );
    if (rows.length === 0) throw new NotFoundError('catalog');
    return {
      ...toCatalog(rows[0]),
      schema: { properties: rows[0].properties },
      variantProperty: rows[0].variant_property,
    };
  }

  /** One stored schema version; defaults to the current one. */
  async getSchemaVersion(
    customerId: string,
    catalogId: string,
    version?: number,
  ): Promise<SchemaVersion> {
    const { rows } = await this.pool.query(
      `SELECT v.catalog_id, v.version, v.properties, v.variant_property, v.changes, v.created_at
       FROM catalogs c
       JOIN catalog_schema_versions v ON v.catalog_id = c.id
       WHERE c.id = $1 AND c.customer_id = $2
         AND v.version = COALESCE($3::int, c.schema_version)`,
      [catalogId, customerId, version ?? null],
    );
    if (rows.length === 0) throw new NotFoundError('schema version');
    return toSchemaVersion(rows[0]);
  }

  /** All versions, oldest first. */
  async listSchemaVersions(
    customerId: string,
    catalogId: string,
  ): Promise<SchemaVersion[]> {
    await this.get(customerId, catalogId);
    const { rows } = await this.pool.query(
      `SELECT catalog_id, version, properties, variant_property, changes, created_at
       FROM catalog_schema_versions WHERE catalog_id = $1 ORDER BY version`,
      [catalogId],
    );
    return rows.map(toSchemaVersion);
  }
}

export function toCatalog(row: any): Catalog {
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
  };
}

export function toSchemaVersion(row: any): SchemaVersion {
  return {
    catalogId: row.catalog_id,
    version: row.version,
    schema: { properties: row.properties },
    variantProperty: row.variant_property,
    changes: row.changes,
    createdAt: row.created_at,
  };
}
