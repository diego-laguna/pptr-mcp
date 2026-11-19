import type { CatalogSchema } from '../../catalog/schema/property-types.js';
import type { SchemaSnapshot } from './types.js';

/**
 * What an attempt may know about a catalog schema. `filterable` is dropped and
 * the variant is named at the top level. The stored variant column wins when
 * given (null meaning none); otherwise the property flagged `variant` is used.
 */
export function snapshotFromSchema(
  schema: CatalogSchema,
  schemaVersion: number,
  variantProperty?: string | null,
): SchemaSnapshot {
  return {
    schemaVersion,
    properties: schema.properties.map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      ...(p.example !== undefined ? { example: p.example } : {}),
      ...(p.values !== undefined ? { values: p.values } : {}),
      required: p.required === true,
    })),
    variantProperty:
      variantProperty !== undefined
        ? variantProperty
        : (schema.properties.find((p) => p.variant)?.name ?? null),
  };
}
