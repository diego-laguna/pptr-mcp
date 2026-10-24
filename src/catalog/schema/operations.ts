import { CatalogSchema, ValidationIssue } from './property-types.js';

export type SchemaOperation =
  | { op: 'add_property'; property: unknown }
  | { op: 'rename_property'; from: string; to: string }
  | { op: 'remove_property'; name: string }
  | {
      op: 'edit_property';
      name: string;
      description?: string;
      /** `null` clears the example. */
      example?: unknown;
      filterable?: boolean;
      /** Not editable: rejected with a hint to remove and re-add. */
      type?: unknown;
      /** Not editable. */
      required?: unknown;
    }
  | { op: 'add_enum_value'; name: string; value: string }
  | { op: 'remove_enum_value'; name: string; value: string };

export interface PlanContext {
  /** True when the catalog already has stored products. */
  hasProducts: boolean;
}

export interface PlanError extends ValidationIssue {
  operationIndex?: number;
}

/** Stored attribute migrations the data layer must run, in order. */
export interface AttributeMigration {
  kind: 'rename' | 'remove';
  from: string;
  to?: string;
}

export interface PlanEffects {
  /** Applied to every stored product's attributes, in this order. */
  attributeMigrations: AttributeMigration[];
  /** Properties new to the schema; each site needs a `property_pending` marker. */
  addedProperties: string[];
  /** Enum values removed; the caller must reject if any stored product uses one. */
  removedEnumValues: { property: string; value: string }[];
}

export type PlanResult =
  | {
      ok: true;
      schema: CatalogSchema;
      /** True when a new immutable schema version must be written. */
      newVersion: boolean;
      /** The operations as applied, stored with the version for later replay. */
      changes: SchemaOperation[];
      effects: PlanEffects;
    }
  | { ok: false; errors: PlanError[] };
