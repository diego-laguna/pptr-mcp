import { CatalogSchema } from './property-types.js';
import { PlanResult, SchemaOperation } from './operations.js';
import { planSchemaChange } from './schema-planner.js';
import { assertValidSchema } from './schema-validator.js';

const clothing = assertValidSchema({
  properties: [
    {
      name: 'gender',
      type: 'enum',
      description: 'Audience',
      values: ['girls', 'boys'],
    },
    { name: 'type', type: 'string', description: 'Garment type' },
    { name: 'size', type: 'string', description: 'Size', variant: true },
    { name: 'unit_system', type: 'string', description: 'Size unit system' },
  ],
});

const noVariant = assertValidSchema({
  properties: [{ name: 'brand', type: 'string', description: 'Brand' }],
});

const plan = (
  operations: SchemaOperation[],
  options: { schema?: CatalogSchema; hasProducts?: boolean } = {},
): PlanResult =>
  planSchemaChange(options.schema ?? clothing, operations, {
    hasProducts: options.hasProducts ?? false,
  });

const errorCodes = (result: PlanResult) =>
  result.ok ? [] : result.errors.map((e) => e.code);

const names = (result: PlanResult) =>
  result.ok ? result.schema.properties.map((p) => p.name) : [];

describe('planSchemaChange', () => {
  describe('add', () => {
    it('adds an optional property, bumps the version and marks it pending', () => {
      const result = plan([
        {
          op: 'add_property',
          property: { name: 'fabric', type: 'string', description: 'Fabric' },
        },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(names(result)).toContain('fabric');
      expect(result.newVersion).toBe(true);
      expect(result.effects.addedProperties).toEqual(['fabric']);
      expect(result.effects.attributeMigrations).toEqual([]);
    });

    it('rejects a name collision', () => {
      const result = plan([
        {
          op: 'add_property',
          property: { name: 'gender', type: 'string', description: 'x' },
        },
      ]);
      expect(errorCodes(result)).toContain('name_collision');
    });

    it('rejects an invalid property definition', () => {
      const result = plan([
        {
          op: 'add_property',
          property: { name: 'price', type: 'string', description: 'x' },
        },
      ]);
      expect(errorCodes(result)).toContain('invalid_property');
    });

    it('rejects a required property when products exist', () => {
      const op: SchemaOperation = {
        op: 'add_property',
        property: {
          name: 'fabric',
          type: 'string',
          description: 'Fabric',
          required: true,
        },
      };
      expect(errorCodes(plan([op], { hasProducts: true }))).toContain(
        'required_with_existing_products',
      );
      expect(plan([op], { hasProducts: false }).ok).toBe(true);
    });

    it('rejects designating a variant property later', () => {
      const result = plan(
        [
          {
            op: 'add_property',
            property: {
              name: 'color',
              type: 'string',
              description: 'c',
              variant: true,
            },
          },
        ],
        { schema: noVariant },
      );
      expect(errorCodes(result)).toContain('variant_designation_fixed');
    });

    it('rejects a second variant property', () => {
      const result = plan([
        {
          op: 'add_property',
          property: {
            name: 'color',
            type: 'string',
            description: 'c',
            variant: true,
          },
        },
      ]);
      expect(errorCodes(result)).toContain('variant_designation_fixed');
    });

    it('rejects growing past 50 properties', () => {
      const big = assertValidSchema({
        properties: Array.from({ length: 50 }, (_, i) => ({
          name: `p${i}`,
          type: 'string',
          description: 'x',
        })),
      });
      const result = plan(
        [
          {
            op: 'add_property',
            property: { name: 'extra', type: 'string', description: 'x' },
          },
        ],
        { schema: big },
      );
      expect(errorCodes(result)).toContain('too_many_properties');
    });
  });

  describe('rename', () => {
    it('renames and migrates stored attributes without marking sites', () => {
      const result = plan([
        { op: 'rename_property', from: 'gender', to: 'audience' },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(names(result)).toContain('audience');
      expect(names(result)).not.toContain('gender');
      expect(result.newVersion).toBe(true);
      expect(result.effects.attributeMigrations).toEqual([
        { kind: 'rename', from: 'gender', to: 'audience' },
      ]);
      expect(result.effects.addedProperties).toEqual([]);
    });

    it('rejects a collision with another property', () => {
      const result = plan([
        { op: 'rename_property', from: 'gender', to: 'type' },
      ]);
      expect(errorCodes(result)).toContain('name_collision');
    });

    it('rejects reserved and invalid target names', () => {
      expect(
        errorCodes(
          plan([{ op: 'rename_property', from: 'gender', to: 'price' }]),
        ),
      ).toContain('invalid_name');
      expect(
        errorCodes(
          plan([{ op: 'rename_property', from: 'gender', to: 'Audience' }]),
        ),
      ).toContain('invalid_name');
    });

    it('rejects renaming a property that does not exist', () => {
      expect(
        errorCodes(plan([{ op: 'rename_property', from: 'nope', to: 'x' }])),
      ).toContain('unknown_property');
    });

    it('renames the variant property without touching attributes', () => {
      const result = plan([
        { op: 'rename_property', from: 'size', to: 'talle' },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.schema.properties.find((p) => p.variant)?.name).toBe(
        'talle',
      );
      expect(result.effects.attributeMigrations).toEqual([]);
    });

    it('keeps renames in order so chained renames migrate correctly', () => {
      const result = plan([
        { op: 'rename_property', from: 'gender', to: 'tmp' },
        { op: 'rename_property', from: 'type', to: 'gender' },
        { op: 'rename_property', from: 'tmp', to: 'type' },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.effects.attributeMigrations).toEqual([
        { kind: 'rename', from: 'gender', to: 'tmp' },
        { kind: 'rename', from: 'type', to: 'gender' },
        { kind: 'rename', from: 'tmp', to: 'type' },
      ]);
    });
  });

  describe('remove', () => {
    it('removes a property and migrates stored attributes', () => {
      const result = plan([{ op: 'remove_property', name: 'unit_system' }]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(names(result)).not.toContain('unit_system');
      expect(result.effects.attributeMigrations).toEqual([
        { kind: 'remove', from: 'unit_system' },
      ]);
      expect(result.effects.addedProperties).toEqual([]);
    });

    it('rejects removing the variant property', () => {
      expect(
        errorCodes(plan([{ op: 'remove_property', name: 'size' }])),
      ).toContain('variant_removal');
    });

    it('needs no migration for a property added in the same batch', () => {
      const result = plan([
        {
          op: 'add_property',
          property: { name: 'fabric', type: 'string', description: 'Fabric' },
        },
        { op: 'remove_property', name: 'fabric' },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.effects.attributeMigrations).toEqual([]);
      expect(result.effects.addedProperties).toEqual([]);
    });
  });

  describe('retype and other unsupported edits', () => {
    it('rejects a retype with a remove-and-add hint', () => {
      const result = plan([
        { op: 'edit_property', name: 'type', type: 'number' },
      ]);
      expect(errorCodes(result)).toContain('retype_not_supported');
      if (!result.ok)
        expect(result.errors[0].message).toMatch(
          /remove the property and add it again/,
        );
    });

    it('rejects changing required', () => {
      expect(
        errorCodes(
          plan([{ op: 'edit_property', name: 'type', required: true }]),
        ),
      ).toContain('unsupported_edit');
    });
  });

  describe('edit', () => {
    it('edits description, example and filterable in place without a new version', () => {
      const result = plan([
        {
          op: 'edit_property',
          name: 'type',
          description: 'The garment type',
          example: 't-shirt',
          filterable: true,
        },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.newVersion).toBe(false);
      const type = result.schema.properties.find((p) => p.name === 'type')!;
      expect(type).toMatchObject({
        description: 'The garment type',
        example: 't-shirt',
        filterable: true,
      });
      expect(result.effects).toEqual({
        attributeMigrations: [],
        addedProperties: [],
        removedEnumValues: [],
      });
    });

    it('clears an example with null', () => {
      const withExample = assertValidSchema({
        properties: [
          {
            name: 'brand',
            type: 'string',
            description: 'Brand',
            example: 'Acme',
          },
        ],
      });
      const result = plan(
        [{ op: 'edit_property', name: 'brand', example: null }],
        { schema: withExample },
      );
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.schema.properties[0]).not.toHaveProperty('example');
    });

    it('rejects an empty description or a mistyped example', () => {
      expect(
        errorCodes(
          plan([{ op: 'edit_property', name: 'type', description: ' ' }]),
        ),
      ).toContain('missing_description');
      expect(
        errorCodes(plan([{ op: 'edit_property', name: 'type', example: 5 }])),
      ).toContain('invalid_example');
    });
  });

  describe('enum values', () => {
    it('adds a value with a new version and no migration', () => {
      const result = plan([
        { op: 'add_enum_value', name: 'gender', value: 'unisex' },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.newVersion).toBe(true);
      expect(result.schema.properties[0].values).toEqual([
        'girls',
        'boys',
        'unisex',
      ]);
      expect(result.effects.attributeMigrations).toEqual([]);
      expect(result.effects.addedProperties).toEqual([]);
    });

    it('reports a removed value so the caller can check usage', () => {
      const result = plan([
        { op: 'remove_enum_value', name: 'gender', value: 'boys' },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.effects.removedEnumValues).toEqual([
          { property: 'gender', value: 'boys' },
        ]);
    });

    it('rejects duplicate, missing and non-enum targets', () => {
      expect(
        errorCodes(
          plan([{ op: 'add_enum_value', name: 'gender', value: 'girls' }]),
        ),
      ).toContain('enum_value_exists');
      expect(
        errorCodes(
          plan([{ op: 'remove_enum_value', name: 'gender', value: 'x' }]),
        ),
      ).toContain('enum_value_missing');
      expect(
        errorCodes(plan([{ op: 'add_enum_value', name: 'type', value: 'x' }])),
      ).toContain('not_enum');
    });

    it('rejects removing the last value', () => {
      const one = assertValidSchema({
        properties: [
          {
            name: 'season',
            type: 'enum',
            description: 's',
            values: ['winter'],
          },
        ],
      });
      const result = plan(
        [{ op: 'remove_enum_value', name: 'season', value: 'winter' }],
        { schema: one },
      );
      expect(errorCodes(result)).toContain('invalid_enum_values');
    });
  });

  describe('batches', () => {
    it('applies operations in order and reports every error', () => {
      const result = plan([
        { op: 'rename_property', from: 'nope', to: 'x' },
        { op: 'remove_property', name: 'size' },
      ]);
      expect(errorCodes(result)).toEqual([
        'unknown_property',
        'variant_removal',
      ]);
    });

    it('rejects an empty batch and unknown operations', () => {
      expect(errorCodes(plan([]))).toContain('no_operations');
      expect(
        errorCodes(plan([{ op: 'explode' } as unknown as SchemaOperation])),
      ).toContain('unknown_operation');
    });

    it('records the applied operations as the change log and leaves the input untouched', () => {
      const ops: SchemaOperation[] = [
        { op: 'rename_property', from: 'gender', to: 'audience' },
      ];
      const before = JSON.stringify(clothing);
      const result = plan(ops);
      expect(result.ok && result.changes).toEqual(ops);
      expect(JSON.stringify(clothing)).toBe(before);
    });
  });
});
