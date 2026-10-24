import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';
import {
  hasPgCode,
  UNIQUE_VIOLATION,
  withTransaction,
} from '../database/transaction.js';
import {
  ConflictError,
  NotFoundError,
  StaleSchemaError,
  ValidationFailedError,
} from './errors.js';
import { validateAttributes } from './schema/attribute-validator.js';
import { CatalogSchema, ValidationIssue } from './schema/property-types.js';
import {
  Product,
  ProductInput,
  ProductSearch,
  ProductVariant,
  VariantMatch,
} from './types.js';

const PRODUCT_COLUMNS =
  'p.id, p.site_id, p.name, p.link, p.thumbnail_url, p.attributes, p.price, p.available, p.updated_at';
const VARIANT_COLUMNS =
  'v.id, v.product_id, v.variant_value, v.price, v.available, v.updated_at';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface CatalogContext {
  schemaVersion: number;
  schema: CatalogSchema;
  variantProperty: string | null;
}

/**
 * Every method takes the customer id and joins through site -> catalog. Writes
 * declare the schema version they were produced under; the catalog row is
 * locked in share mode so a concurrent schema change cannot slip in between
 * the staleness check and the write.
 */
@Injectable()
export class ProductsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async create(
    customerId: string,
    siteId: string,
    pinnedSchemaVersion: number,
    input: ProductInput,
  ): Promise<Product> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const context = await this.lockCatalog(client, customerId, siteId);
        this.assertWritable(context, pinnedSchemaVersion, input);

        const { rows } = await client.query(
          `INSERT INTO products (site_id, name, link, thumbnail_url, attributes, price, available)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, site_id, name, link, thumbnail_url, attributes, price, available, updated_at`,
          [
            siteId,
            input.name,
            input.link,
            input.thumbnailUrl ?? null,
            JSON.stringify(input.attributes ?? {}),
            input.price ?? null,
            input.available ?? null,
          ],
        );
        const variants = await this.insertVariants(client, rows[0].id, input);
        return { ...toProduct(rows[0]), variants };
      });
    } catch (error) {
      if (hasPgCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictError(
          `the site already has a product with link ${input.link}`,
        );
      }
      throw error;
    }
  }

  /** Replaces a product's mutable fields and its variants. */
  async update(
    customerId: string,
    productId: string,
    pinnedSchemaVersion: number,
    input: ProductInput,
  ): Promise<Product> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const found = await client.query(
          `SELECT p.id, p.site_id FROM products p
           JOIN sites s ON s.id = p.site_id JOIN catalogs c ON c.id = s.catalog_id
           WHERE p.id = $1 AND c.customer_id = $2`,
          [productId, customerId],
        );
        if (found.rows.length === 0) throw new NotFoundError('product');

        const context = await this.lockCatalog(
          client,
          customerId,
          found.rows[0].site_id,
        );
        this.assertWritable(context, pinnedSchemaVersion, input);

        const { rows } = await client.query(
          `UPDATE products SET name = $2, link = $3, thumbnail_url = $4, attributes = $5,
                  price = $6, available = $7, updated_at = now()
           WHERE id = $1
           RETURNING id, site_id, name, link, thumbnail_url, attributes, price, available, updated_at`,
          [
            productId,
            input.name,
            input.link,
            input.thumbnailUrl ?? null,
            JSON.stringify(input.attributes ?? {}),
            input.price ?? null,
            input.available ?? null,
          ],
        );
        await client.query(
          'DELETE FROM product_variants WHERE product_id = $1',
          [productId],
        );
        const variants = await this.insertVariants(client, productId, input);
        return { ...toProduct(rows[0]), variants };
      });
    } catch (error) {
      if (hasPgCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictError(
          `the site already has a product with link ${input.link}`,
        );
      }
      throw error;
    }
  }

  async get(customerId: string, productId: string): Promise<Product> {
    const { rows } = await this.pool.query(
      `SELECT ${PRODUCT_COLUMNS} FROM products p
       JOIN sites s ON s.id = p.site_id JOIN catalogs c ON c.id = s.catalog_id
       WHERE p.id = $1 AND c.customer_id = $2`,
      [productId, customerId],
    );
    if (rows.length === 0) throw new NotFoundError('product');
    const variants = await this.pool.query(
      `SELECT ${VARIANT_COLUMNS} FROM product_variants v WHERE v.product_id = $1 ORDER BY v.variant_value`,
      [productId],
    );
    return { ...toProduct(rows[0]), variants: variants.rows.map(toVariant) };
  }

  /** Deleting a product deletes its variants with it. */
  async delete(customerId: string, productId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM products p USING sites s, catalogs c
       WHERE p.site_id = s.id AND s.catalog_id = c.id AND p.id = $1 AND c.customer_id = $2`,
      [productId, customerId],
    );
    if (rowCount === 0) throw new NotFoundError('product');
  }

  /**
   * Lookups within one customer's scope: by catalog or site, attribute
   * containment and free text on the name. Another customer's ids simply
   * match nothing.
   */
  async search(
    customerId: string,
    search: ProductSearch = {},
  ): Promise<Omit<Product, 'variants'>[]> {
    const { where, values } = scopeClauses(customerId, search);
    if (search.attributes !== undefined) {
      values.push(JSON.stringify(search.attributes));
      where.push(`p.attributes @> $${values.length}::jsonb`);
    }
    if (search.text !== undefined && search.text.trim() !== '') {
      values.push(search.text);
      where.push(
        `to_tsvector('simple', p.name) @@ plainto_tsquery('simple', $${values.length})`,
      );
    }
    values.push(clampLimit(search.limit), Math.max(0, search.offset ?? 0));
    const { rows } = await this.pool.query(
      `SELECT ${PRODUCT_COLUMNS} FROM products p
       JOIN sites s ON s.id = p.site_id JOIN catalogs c ON c.id = s.catalog_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.name, p.id
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows.map(toProduct);
  }

  /** Variants with a given value, each with its product. */
  async findVariantsByValue(
    customerId: string,
    value: string,
    scope: Pick<
      ProductSearch,
      'catalogId' | 'siteId' | 'limit' | 'offset'
    > = {},
  ): Promise<VariantMatch[]> {
    const { where, values } = scopeClauses(customerId, scope);
    values.push(value);
    where.push(`v.variant_value = $${values.length}`);
    values.push(clampLimit(scope.limit), Math.max(0, scope.offset ?? 0));
    const { rows } = await this.pool.query(
      `SELECT ${VARIANT_COLUMNS}, ${PRODUCT_COLUMNS.split(', ')
        .map((c) => `${c} AS "p_${c.slice(2)}"`)
        .join(', ')}
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       JOIN sites s ON s.id = p.site_id JOIN catalogs c ON c.id = s.catalog_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.name, p.id
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows.map((row) => ({
      variant: toVariant(row),
      product: toProduct({
        id: row.p_id,
        site_id: row.p_site_id,
        name: row.p_name,
        link: row.p_link,
        thumbnail_url: row.p_thumbnail_url,
        attributes: row.p_attributes,
        price: row.p_price,
        available: row.p_available,
        updated_at: row.p_updated_at,
      }),
    }));
  }

  private async lockCatalog(
    client: pg.PoolClient,
    customerId: string,
    siteId: string,
  ): Promise<CatalogContext> {
    const { rows } = await client.query(
      `SELECT c.schema_version, v.properties, v.variant_property
       FROM sites s
       JOIN catalogs c ON c.id = s.catalog_id
       JOIN catalog_schema_versions v ON v.catalog_id = c.id AND v.version = c.schema_version
       WHERE s.id = $1 AND c.customer_id = $2
       FOR SHARE OF c`,
      [siteId, customerId],
    );
    if (rows.length === 0) throw new NotFoundError('site');
    return {
      schemaVersion: rows[0].schema_version,
      schema: { properties: rows[0].properties },
      variantProperty: rows[0].variant_property,
    };
  }

  private assertWritable(
    context: CatalogContext,
    pinnedSchemaVersion: number,
    input: ProductInput,
  ): void {
    if (pinnedSchemaVersion !== context.schemaVersion) {
      throw new StaleSchemaError(pinnedSchemaVersion, context.schemaVersion);
    }
    const issues = [
      ...validateProductFields(input),
      ...validateAttributes(context.schema, input.attributes ?? {}),
      ...validatePriceShape(context.variantProperty, input),
    ];
    if (issues.length > 0)
      throw new ValidationFailedError('invalid product', issues);
  }

  private async insertVariants(
    client: pg.PoolClient,
    productId: string,
    input: ProductInput,
  ): Promise<ProductVariant[]> {
    const variants: ProductVariant[] = [];
    for (const variant of input.variants ?? []) {
      const { rows } = await client.query(
        `INSERT INTO product_variants (product_id, variant_value, price, available)
         VALUES ($1, $2, $3, $4)
         RETURNING id, product_id, variant_value, price, available, updated_at`,
        [productId, variant.value, variant.price, variant.available],
      );
      variants.push(toVariant(rows[0]));
    }
    return variants;
  }
}

function validateProductFields(input: ProductInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    issues.push({
      path: 'name',
      code: 'missing_name',
      message: 'a name is required',
    });
  }
  if (typeof input.link !== 'string' || input.link.trim() === '') {
    issues.push({
      path: 'link',
      code: 'missing_link',
      message: 'a link is required',
    });
  }
  return issues;
}

/**
 * With a variant property, price and availability live on variants; without
 * one they live on the product and no variants exist.
 */
function validatePriceShape(
  variantProperty: string | null,
  input: ProductInput,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const variants = input.variants ?? [];
  const hasProductPrice =
    (input.price !== undefined && input.price !== null) ||
    (input.available !== undefined && input.available !== null);

  if (variantProperty !== null) {
    if (hasProductPrice) {
      issues.push({
        path: 'price',
        code: 'price_on_product',
        message: `the catalog has a variant property ("${variantProperty}"), so price and availability belong on variants`,
      });
    }
    const seen = new Set<string>();
    variants.forEach((variant, index) => {
      const path = `variants[${index}]`;
      if (typeof variant.value !== 'string' || variant.value.trim() === '') {
        issues.push({
          path: `${path}.value`,
          code: 'missing_variant_value',
          message: 'a variant value is required',
        });
      } else if (seen.has(variant.value)) {
        issues.push({
          path: `${path}.value`,
          code: 'duplicate_variant',
          message: `variant "${variant.value}" appears more than once`,
        });
      }
      seen.add(variant.value);
      if (typeof variant.price !== 'string' || variant.price.trim() === '') {
        issues.push({
          path: `${path}.price`,
          code: 'missing_price',
          message: 'a price text is required',
        });
      }
      if (typeof variant.available !== 'boolean') {
        issues.push({
          path: `${path}.available`,
          code: 'invalid_availability',
          message: 'availability must be a boolean',
        });
      }
    });
  } else {
    if (variants.length > 0) {
      issues.push({
        path: 'variants',
        code: 'variants_without_variant_property',
        message:
          'the catalog has no variant property, so products cannot have variants',
      });
    }
    if (
      input.price !== undefined &&
      input.price !== null &&
      typeof input.price !== 'string'
    ) {
      issues.push({
        path: 'price',
        code: 'invalid_price',
        message: 'price must be the text shown on the site',
      });
    }
    if (
      input.available !== undefined &&
      input.available !== null &&
      typeof input.available !== 'boolean'
    ) {
      issues.push({
        path: 'available',
        code: 'invalid_availability',
        message: 'availability must be a boolean',
      });
    }
  }
  return issues;
}

function scopeClauses(
  customerId: string,
  scope: Pick<ProductSearch, 'catalogId' | 'siteId'>,
): { where: string[]; values: unknown[] } {
  const values: unknown[] = [customerId];
  const where = ['c.customer_id = $1'];
  if (scope.catalogId !== undefined) {
    values.push(scope.catalogId);
    where.push(`c.id = $${values.length}`);
  }
  if (scope.siteId !== undefined) {
    values.push(scope.siteId);
    where.push(`s.id = $${values.length}`);
  }
  return { where, values };
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);
}

function toProduct(row: any): Omit<Product, 'variants'> {
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    link: row.link,
    thumbnailUrl: row.thumbnail_url,
    attributes: row.attributes,
    price: row.price,
    available: row.available,
    updatedAt: row.updated_at,
  };
}

function toVariant(row: any): ProductVariant {
  return {
    id: row.id,
    productId: row.product_id,
    variantValue: row.variant_value,
    price: row.price,
    available: row.available,
    updatedAt: row.updated_at,
  };
}
