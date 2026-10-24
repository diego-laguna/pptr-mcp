export const PROPERTY_TYPES = [
  'string',
  'number',
  'boolean',
  'url',
  'date',
  'enum',
  'string_list',
] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];

export interface PropertyDefinition {
  name: string;
  type: PropertyType;
  description: string;
  required: boolean;
  filterable: boolean;
  /** Present (and true) only on the single variant property. */
  variant?: true;
  example?: unknown;
  /** Allowed values; present only on enum properties. */
  values?: string[];
}

export interface CatalogSchema {
  properties: PropertyDefinition[];
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

/** Names that the product record itself uses, so schema properties cannot. */
export const RESERVED_NAMES: readonly string[] = [
  'name',
  'link',
  'price',
  'thumbnail_url',
  'updated',
  'available',
];

export const MAX_PROPERTIES = 50;

export const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** True when `value` is a valid canonical value for the property's type. */
export function conformsToType(
  property: Pick<PropertyDefinition, 'type' | 'values'>,
  value: unknown,
): boolean {
  switch (property.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'url':
      return isHttpUrl(value);
    case 'date':
      return isIsoCalendarDate(value);
    case 'enum':
      return (
        typeof value === 'string' && (property.values ?? []).includes(value)
      );
    case 'string_list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
  }
}

export function variantPropertyOf(
  schema: CatalogSchema,
): PropertyDefinition | undefined {
  return schema.properties.find((p) => p.variant === true);
}
