import {
  CatalogSchema,
  conformsToType,
  isIsoCalendarDate,
  ValidationIssue,
  variantPropertyOf,
} from './property-types.js';

/**
 * Checks a product's attributes against the catalog's current schema. Values
 * must already be canonical (for example dates as `YYYY-MM-DD`): conversion
 * from site text happens upstream, in the scrape run.
 */
export function validateAttributes(
  schema: CatalogSchema,
  attributes: unknown,
): ValidationIssue[] {
  if (
    typeof attributes !== 'object' ||
    attributes === null ||
    Array.isArray(attributes)
  ) {
    return [
      {
        path: 'attributes',
        code: 'invalid_attributes',
        message: 'attributes must be an object',
      },
    ];
  }

  const issues: ValidationIssue[] = [];
  const values = attributes as Record<string, unknown>;
  const variant = variantPropertyOf(schema);
  const declared = new Map(
    schema.properties.filter((p) => !p.variant).map((p) => [p.name, p]),
  );

  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      issues.push({
        path: `attributes.${key}`,
        code:
          key === variant?.name
            ? 'variant_in_attributes'
            : 'undeclared_property',
        message:
          key === variant?.name
            ? `"${key}" is the variant property and belongs on product variants`
            : `"${key}" is not declared by the catalog's schema`,
      });
    }
  }

  for (const property of declared.values()) {
    const value = values[property.name];
    if (value === undefined) {
      if (property.required) {
        issues.push({
          path: `attributes.${property.name}`,
          code: 'missing_required',
          message: `"${property.name}" is required`,
        });
      }
      continue;
    }
    if (!conformsToType(property, value)) {
      issues.push({
        path: `attributes.${property.name}`,
        code: property.type === 'enum' ? 'value_not_allowed' : 'invalid_value',
        message:
          property.type === 'enum'
            ? `"${property.name}" must be one of ${(property.values ?? []).join(', ')}`
            : property.type === 'date' &&
                typeof value === 'string' &&
                !isIsoCalendarDate(value)
              ? `"${property.name}" must be a valid calendar date in YYYY-MM-DD form`
              : `"${property.name}" must be of type ${property.type}`,
      });
    }
  }

  return issues;
}
