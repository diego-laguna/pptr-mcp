import { SchemaShape } from '../contracts/messages.js';
import {
  CatalogSchema,
  variantPropertyOf,
} from '../../catalog/schema/property-types.js';
import { SelectorSpec } from '../spec/selector-spec.js';

export function schemaShapeOf(schema: CatalogSchema): SchemaShape {
  return {
    properties: schema.properties.map((p) => p.name),
    variantProperty: variantPropertyOf(schema)?.name ?? null,
  };
}

/**
 * Problems that make the spec unusable for the pinned schema. A schema
 * property the spec does not bind is fine: it is simply absent from items.
 */
export function schemaMismatches(
  spec: SelectorSpec,
  schema: SchemaShape,
): string[] {
  const declared = new Set(schema.properties);
  const problems: string[] = [];
  for (const name of Object.keys(spec.properties)) {
    if (!declared.has(name))
      problems.push(`spec binds "${name}" but the schema does not declare it`);
    else if (name === schema.variantProperty)
      problems.push(
        `"${name}" is the variant property; bind it under variants`,
      );
  }
  if (spec.variants && !schema.variantProperty)
    problems.push('spec binds variants but the schema has no variant property');
  return problems;
}
