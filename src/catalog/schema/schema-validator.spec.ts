import { MAX_PROPERTIES } from './property-types.js';
import {
  parseSchema,
  assertValidSchema,
  SchemaValidationError,
} from './schema-validator.js';

const prop = (over: Record<string, unknown> = {}) => ({
  name: 'price_note',
  type: 'string',
  description: 'A note about the price',
  ...over,
});

const codes = (input: unknown) => {
  const result = parseSchema(input);
  return result.ok ? [] : result.issues.map((i) => i.code);
};

describe('schema validator', () => {
  describe('Property definition', () => {
    it('accepts a valid property and normalizes flags', () => {
      const result = parseSchema({ properties: [prop()] });
      expect(result).toEqual({
        ok: true,
        schema: {
          properties: [
            {
              name: 'price_note',
              type: 'string',
              description: 'A note about the price',
              required: false,
              filterable: false,
            },
          ],
        },
      });
    });

    it('rejects an empty description', () => {
      expect(codes({ properties: [prop({ description: '  ' })] })).toContain(
        'missing_description',
      );
    });

    it('rejects an enum without values', () => {
      expect(
        codes({
          properties: [prop({ name: 'season', type: 'enum', values: [] })],
        }),
      ).toContain('invalid_enum_values');
      expect(
        codes({ properties: [prop({ name: 'season', type: 'enum' })] }),
      ).toContain('invalid_enum_values');
    });

    it('rejects duplicate enum values', () => {
      expect(
        codes({
          properties: [
            prop({ name: 'season', type: 'enum', values: ['a', 'a'] }),
          ],
        }),
      ).toContain('duplicate_enum_values');
    });

    it('rejects values on a non-enum property', () => {
      expect(codes({ properties: [prop({ values: ['a'] })] })).toContain(
        'unexpected_values',
      );
    });

    it('rejects an example of the wrong type', () => {
      expect(
        codes({
          properties: [
            prop({ name: 'weight', type: 'number', example: 'abc' }),
          ],
        }),
      ).toContain('invalid_example');
    });

    it('rejects a date example in a site format', () => {
      expect(
        codes({
          properties: [
            prop({
              name: 'promotion_date',
              type: 'date',
              example: '15/10/2026',
            }),
          ],
        }),
      ).toContain('invalid_example');
    });

    it('rejects an impossible calendar date example', () => {
      expect(
        codes({
          properties: [
            prop({
              name: 'promotion_date',
              type: 'date',
              example: '2026-02-31',
            }),
          ],
        }),
      ).toContain('invalid_example');
    });

    it('accepts a valid date property', () => {
      const result = parseSchema({
        properties: [
          prop({ name: 'promotion_date', type: 'date', example: '2026-10-15' }),
        ],
      });
      expect(result.ok).toBe(true);
    });

    it('requires an enum example to be one of the values', () => {
      expect(
        codes({
          properties: [
            prop({
              name: 'season',
              type: 'enum',
              values: ['winter'],
              example: 'summer',
            }),
          ],
        }),
      ).toContain('invalid_example');
    });

    it('rejects unknown types, flags and keys', () => {
      expect(codes({ properties: [prop({ type: 'datetime' })] })).toContain(
        'invalid_type',
      );
      expect(codes({ properties: [prop({ required: 'yes' })] })).toContain(
        'invalid_flag',
      );
      expect(codes({ properties: [prop({ descripton: 'typo' })] })).toContain(
        'unknown_key',
      );
    });

    it('rejects input that is not a schema object', () => {
      expect(codes(null)).toContain('invalid_schema');
      expect(codes({ properties: 'nope' })).toContain('invalid_schema');
    });
  });

  describe('Property names', () => {
    it('rejects a reserved name', () => {
      expect(codes({ properties: [prop({ name: 'price' })] })).toContain(
        'reserved_name',
      );
    });

    it.each(['name', 'link', 'price', 'thumbnail_url', 'updated', 'available'])(
      'rejects system field %s',
      (name) => {
        expect(codes({ properties: [prop({ name })] })).toContain(
          'reserved_name',
        );
      },
    );

    it('rejects a duplicate name', () => {
      expect(
        codes({ properties: [prop({ name: 'size' }), prop({ name: 'size' })] }),
      ).toContain('duplicate_name');
    });

    it.each(['Talle Niño', 'Size', '1size', 'size-x', ''])(
      'rejects name %j',
      (name) => {
        expect(codes({ properties: [prop({ name })] })).toContain(
          'invalid_name',
        );
      },
    );
  });

  describe('Schema size limit', () => {
    const many = (count: number) => ({
      properties: Array.from({ length: count }, (_, i) =>
        prop({ name: `p${i}` }),
      ),
    });

    it('accepts exactly the maximum', () => {
      expect(parseSchema(many(MAX_PROPERTIES)).ok).toBe(true);
    });

    it('rejects 51 properties', () => {
      expect(codes(many(MAX_PROPERTIES + 1))).toContain('too_many_properties');
    });
  });

  describe('Optional variant property', () => {
    it('accepts one variant property', () => {
      const result = parseSchema({
        properties: [
          prop({ name: 'size', variant: true }),
          prop({ name: 'color' }),
        ],
      });
      expect(result.ok).toBe(true);
    });

    it('accepts a schema with no variant property', () => {
      expect(parseSchema({ properties: [prop()] }).ok).toBe(true);
    });

    it('rejects two variant properties', () => {
      expect(
        codes({
          properties: [
            prop({ name: 'size', variant: true }),
            prop({ name: 'color', variant: true }),
          ],
        }),
      ).toContain('multiple_variant_properties');
    });
  });

  describe('assertValidSchema', () => {
    it('throws with every issue listed', () => {
      expect(() =>
        assertValidSchema({
          properties: [prop({ name: 'price', description: '' })],
        }),
      ).toThrow(SchemaValidationError);
    });
  });
});
