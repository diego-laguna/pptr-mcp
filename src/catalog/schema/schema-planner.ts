import {
  CatalogSchema,
  conformsToType,
  PROPERTY_NAME_PATTERN,
  PropertyDefinition,
  RESERVED_NAMES,
  ValidationIssue,
  variantPropertyOf,
} from './property-types.js';
import {
  AttributeMigration,
  PlanContext,
  PlanError,
  PlanResult,
  SchemaOperation,
} from './operations.js';
import { parseProperty, parseSchema } from './schema-validator.js';

class OperationRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Applies explicit operations, in order, to the current schema. Pure: no I/O.
 * Operations are never derived from a diff, because a rename cannot be told
 * apart from remove-plus-add and guessing wrong would drop data.
 */
export function planSchemaChange(
  current: CatalogSchema,
  operations: SchemaOperation[],
  context: PlanContext,
): PlanResult {
  if (operations.length === 0) {
    return {
      ok: false,
      errors: [
        {
          path: 'operations',
          code: 'no_operations',
          message: 'no operations given',
        },
      ],
    };
  }

  const hadVariant = variantPropertyOf(current) !== undefined;
  let properties: PropertyDefinition[] = current.properties.map((p) => ({
    ...p,
    ...(p.values ? { values: [...p.values] } : {}),
  }));

  // current name -> whether the property existed (and may have data) before the batch
  const preExisting = new Map<string, boolean>(
    properties.map((p) => [p.name, true]),
  );
  // Migrations are recorded in the order the operations ran, so applying them
  // sequentially to stored data mirrors the schema (renames can chain safely).
  const attributeMigrations: AttributeMigration[] = [];
  const removedEnumValues: { property: string; value: string }[] = [];
  let structural = false;
  const errors: PlanError[] = [];

  operations.forEach((operation, index) => {
    try {
      const outcome = applyOperation(
        operation,
        properties,
        preExisting,
        context,
        hadVariant,
      );
      properties = outcome.properties;
      structural ||= outcome.structural;
      if (outcome.migration) attributeMigrations.push(outcome.migration);
      if (outcome.removedEnumValue)
        removedEnumValues.push(outcome.removedEnumValue);
    } catch (error) {
      if (error instanceof OperationRejected) {
        errors.push({
          path: `operations[${index}]`,
          code: error.code,
          message: error.message,
          operationIndex: index,
        });
      } else {
        throw error;
      }
    }
  });

  if (errors.length > 0) return { ok: false, errors };

  const validated = parseSchema({ properties });
  if (!validated.ok) {
    return {
      ok: false,
      errors: validated.issues.map((issue) => ({ ...issue })),
    };
  }

  const variantName = variantPropertyOf(validated.schema)?.name;
  const addedProperties = [...preExisting]
    .filter(([name, existed]) => !existed && name !== variantName)
    .map(([name]) => name);

  return {
    ok: true,
    schema: validated.schema,
    newVersion: structural,
    changes: operations,
    effects: { attributeMigrations, addedProperties, removedEnumValues },
  };
}

interface Outcome {
  properties: PropertyDefinition[];
  structural: boolean;
  migration?: AttributeMigration;
  removedEnumValue?: { property: string; value: string };
}

function find(
  properties: PropertyDefinition[],
  name: unknown,
): PropertyDefinition {
  const property = properties.find((p) => p.name === name);
  if (!property) {
    throw new OperationRejected(
      'unknown_property',
      `property "${String(name)}" does not exist`,
    );
  }
  return property;
}

function applyOperation(
  operation: SchemaOperation,
  properties: PropertyDefinition[],
  preExisting: Map<string, boolean>,
  context: PlanContext,
  hadVariant: boolean,
): Outcome {
  switch (operation.op) {
    case 'add_property': {
      const issues: ValidationIssue[] = [];
      const parsed = parseProperty(operation.property, 'property', issues);
      if (!parsed) {
        throw new OperationRejected(
          'invalid_property',
          issues.map((i) => `${i.path}: ${i.message}`).join('; '),
        );
      }
      if (properties.some((p) => p.name === parsed.name)) {
        throw new OperationRejected(
          'name_collision',
          `property "${parsed.name}" already exists`,
        );
      }
      if (parsed.variant) {
        throw new OperationRejected(
          'variant_designation_fixed',
          hadVariant
            ? 'the catalog already has a variant property'
            : 'the variant property is fixed when the catalog is created and cannot be added later',
        );
      }
      if (parsed.required && context.hasProducts) {
        throw new OperationRejected(
          'required_with_existing_products',
          `cannot add required property "${parsed.name}": existing products cannot have a value for it`,
        );
      }
      preExisting.set(parsed.name, false);
      return { properties: [...properties, parsed], structural: true };
    }

    case 'rename_property': {
      const property = find(properties, operation.from);
      if (
        typeof operation.to !== 'string' ||
        !PROPERTY_NAME_PATTERN.test(operation.to) ||
        RESERVED_NAMES.includes(operation.to)
      ) {
        throw new OperationRejected(
          'invalid_name',
          `"${String(operation.to)}" is not a valid property name`,
        );
      }
      if (operation.to === operation.from) {
        throw new OperationRejected(
          'invalid_name',
          'the new name equals the old name',
        );
      }
      if (properties.some((p) => p.name === operation.to)) {
        throw new OperationRejected(
          'name_collision',
          `property "${operation.to}" already exists`,
        );
      }
      const existed = preExisting.get(operation.from) === true;
      preExisting.delete(operation.from);
      preExisting.set(operation.to, existed);
      return {
        properties: properties.map((p) =>
          p === property ? { ...p, name: operation.to } : p,
        ),
        structural: true,
        // Variant values live in product variants, not in attributes.
        migration:
          existed && !property.variant
            ? { kind: 'rename', from: operation.from, to: operation.to }
            : undefined,
      };
    }

    case 'remove_property': {
      const property = find(properties, operation.name);
      if (property.variant) {
        throw new OperationRejected(
          'variant_removal',
          'the variant property cannot be removed',
        );
      }
      const existed = preExisting.get(operation.name) === true;
      preExisting.delete(operation.name);
      return {
        properties: properties.filter((p) => p !== property),
        structural: true,
        migration: existed
          ? { kind: 'remove', from: operation.name }
          : undefined,
      };
    }

    case 'edit_property': {
      const property = find(properties, operation.name);
      if (operation.type !== undefined && operation.type !== property.type) {
        throw new OperationRejected(
          'retype_not_supported',
          `cannot change the type of "${property.name}": remove the property and add it again`,
        );
      }
      if (
        operation.required !== undefined &&
        operation.required !== property.required
      ) {
        throw new OperationRejected(
          'unsupported_edit',
          `cannot change whether "${property.name}" is required`,
        );
      }
      const edited: PropertyDefinition = { ...property };
      if (operation.description !== undefined) {
        if (
          typeof operation.description !== 'string' ||
          operation.description.trim() === ''
        ) {
          throw new OperationRejected(
            'missing_description',
            'a non-empty description is required',
          );
        }
        edited.description = operation.description.trim();
      }
      if (operation.filterable !== undefined) {
        if (typeof operation.filterable !== 'boolean') {
          throw new OperationRejected(
            'invalid_flag',
            'filterable must be a boolean',
          );
        }
        edited.filterable = operation.filterable;
      }
      if (operation.example === null) {
        delete edited.example;
      } else if (operation.example !== undefined) {
        if (!conformsToType(edited, operation.example)) {
          throw new OperationRejected(
            'invalid_example',
            `the example does not conform to type ${edited.type}`,
          );
        }
        edited.example = operation.example;
      }
      return {
        properties: properties.map((p) => (p === property ? edited : p)),
        structural: false,
      };
    }

    case 'add_enum_value': {
      const property = find(properties, operation.name);
      if (property.type !== 'enum') {
        throw new OperationRejected(
          'not_enum',
          `"${property.name}" is not an enum property`,
        );
      }
      if (typeof operation.value !== 'string' || operation.value === '') {
        throw new OperationRejected(
          'invalid_enum_values',
          'an enum value must be a non-empty string',
        );
      }
      if (property.values?.includes(operation.value)) {
        throw new OperationRejected(
          'enum_value_exists',
          `"${operation.value}" is already allowed`,
        );
      }
      return {
        properties: properties.map((p) =>
          p === property
            ? { ...p, values: [...(p.values ?? []), operation.value] }
            : p,
        ),
        structural: true,
      };
    }

    case 'remove_enum_value': {
      const property = find(properties, operation.name);
      if (property.type !== 'enum') {
        throw new OperationRejected(
          'not_enum',
          `"${property.name}" is not an enum property`,
        );
      }
      if (!property.values?.includes(operation.value)) {
        throw new OperationRejected(
          'enum_value_missing',
          `"${operation.value}" is not an allowed value`,
        );
      }
      return {
        properties: properties.map((p) =>
          p === property
            ? { ...p, values: p.values!.filter((v) => v !== operation.value) }
            : p,
        ),
        structural: true,
        removedEnumValue: { property: property.name, value: operation.value },
      };
    }

    default:
      throw new OperationRejected(
        'unknown_operation',
        `unknown operation "${String((operation as { op?: unknown }).op)}"`,
      );
  }
}
