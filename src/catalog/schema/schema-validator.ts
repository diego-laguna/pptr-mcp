import {
  CatalogSchema,
  conformsToType,
  MAX_PROPERTIES,
  PROPERTY_NAME_PATTERN,
  PROPERTY_TYPES,
  PropertyDefinition,
  PropertyType,
  RESERVED_NAMES,
  ValidationIssue,
} from './property-types.js';

const PROPERTY_KEYS = new Set([
  'name',
  'type',
  'description',
  'required',
  'filterable',
  'variant',
  'example',
  'values',
]);

export type SchemaParseResult =
  | { ok: true; schema: CatalogSchema }
  | { ok: false; issues: ValidationIssue[] };

export class SchemaValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(
      `Invalid schema: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
    this.name = 'SchemaValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates untrusted input and returns the normalized schema. `required` and
 * `filterable` default to false when omitted; `variant` is kept only when true.
 */
export function parseSchema(input: unknown): SchemaParseResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input) || !Array.isArray(input.properties)) {
    return {
      ok: false,
      issues: [
        {
          path: 'properties',
          code: 'invalid_schema',
          message: 'a schema must be an object with a properties array',
        },
      ],
    };
  }

  const raw = input.properties;
  if (raw.length > MAX_PROPERTIES) {
    issues.push({
      path: 'properties',
      code: 'too_many_properties',
      message: `a schema may have at most ${MAX_PROPERTIES} properties, got ${raw.length}`,
    });
  }

  const properties: PropertyDefinition[] = [];
  const seen = new Set<string>();
  const variants: string[] = [];

  raw.forEach((item, index) => {
    const path = `properties[${index}]`;
    const parsed = parseProperty(item, path, issues);
    if (!parsed) return;

    if (seen.has(parsed.name)) {
      issues.push({
        path: `${path}.name`,
        code: 'duplicate_name',
        message: `property "${parsed.name}" is defined more than once`,
      });
    }
    seen.add(parsed.name);
    if (parsed.variant) variants.push(parsed.name);
    properties.push(parsed);
  });

  if (variants.length > 1) {
    issues.push({
      path: 'properties',
      code: 'multiple_variant_properties',
      message: `at most one variant property is allowed, got ${variants.join(', ')}`,
    });
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, schema: { properties } };
}

export function assertValidSchema(input: unknown): CatalogSchema {
  const result = parseSchema(input);
  if (!result.ok) throw new SchemaValidationError(result.issues);
  return result.schema;
}

/** Validates a single property definition; returns it normalized, or undefined. */
export function parseProperty(
  item: unknown,
  path: string,
  issues: ValidationIssue[],
): PropertyDefinition | undefined {
  const before = issues.length;
  if (!isRecord(item)) {
    issues.push({
      path,
      code: 'invalid_property',
      message: 'must be an object',
    });
    return undefined;
  }

  for (const key of Object.keys(item)) {
    if (!PROPERTY_KEYS.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        code: 'unknown_key',
        message: `unknown key "${key}"`,
      });
    }
  }

  const name = item.name;
  if (typeof name !== 'string' || !PROPERTY_NAME_PATTERN.test(name)) {
    issues.push({
      path: `${path}.name`,
      code: 'invalid_name',
      message:
        'must be lowercase letters, digits and underscores, starting with a letter',
    });
  } else if (RESERVED_NAMES.includes(name)) {
    issues.push({
      path: `${path}.name`,
      code: 'reserved_name',
      message: `"${name}" is a system field name and cannot be used`,
    });
  }

  const type = item.type;
  if (
    typeof type !== 'string' ||
    !PROPERTY_TYPES.includes(type as PropertyType)
  ) {
    issues.push({
      path: `${path}.type`,
      code: 'invalid_type',
      message: `must be one of ${PROPERTY_TYPES.join(', ')}`,
    });
  }

  const description = item.description;
  if (typeof description !== 'string' || description.trim() === '') {
    issues.push({
      path: `${path}.description`,
      code: 'missing_description',
      message: 'a non-empty description is required',
    });
  }

  for (const flag of ['required', 'filterable', 'variant'] as const) {
    if (item[flag] !== undefined && typeof item[flag] !== 'boolean') {
      issues.push({
        path: `${path}.${flag}`,
        code: 'invalid_flag',
        message: `${flag} must be a boolean`,
      });
    }
  }

  let values: string[] | undefined;
  if (type === 'enum') {
    const rawValues = item.values;
    if (
      !Array.isArray(rawValues) ||
      rawValues.length === 0 ||
      !rawValues.every((v) => typeof v === 'string' && v !== '')
    ) {
      issues.push({
        path: `${path}.values`,
        code: 'invalid_enum_values',
        message: 'an enum must list at least one non-empty string value',
      });
    } else if (new Set(rawValues).size !== rawValues.length) {
      issues.push({
        path: `${path}.values`,
        code: 'duplicate_enum_values',
        message: 'enum values must be unique',
      });
    } else {
      values = rawValues as string[];
    }
  } else if (item.values !== undefined) {
    issues.push({
      path: `${path}.values`,
      code: 'unexpected_values',
      message: 'only enum properties may list values',
    });
  }

  if (issues.length > before) return undefined;

  const property: PropertyDefinition = {
    name: name as string,
    type: type as PropertyType,
    description: (description as string).trim(),
    required: item.required === true,
    filterable: item.filterable === true,
  };
  if (item.variant === true) property.variant = true;
  if (values) property.values = values;

  if (item.example !== undefined) {
    if (!conformsToType(property, item.example)) {
      issues.push({
        path: `${path}.example`,
        code: 'invalid_example',
        message:
          property.type === 'date'
            ? 'a date example must be a valid calendar date in YYYY-MM-DD form'
            : `the example does not conform to type ${property.type}`,
      });
      return undefined;
    }
    property.example = item.example;
  }

  return property;
}
