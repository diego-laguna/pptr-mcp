import { validateAttributes } from './attribute-validator.js';
import { assertValidSchema } from './schema-validator.js';

const schema = assertValidSchema({
  properties: [
    {
      name: 'gender',
      type: 'enum',
      description: 'Audience',
      values: ['girls', 'boys'],
      required: true,
    },
    { name: 'type', type: 'string', description: 'Garment type' },
    { name: 'weight', type: 'number', description: 'Weight' },
    { name: 'organic', type: 'boolean', description: 'Organic' },
    { name: 'photo', type: 'url', description: 'Photo' },
    { name: 'tags', type: 'string_list', description: 'Tags' },
    { name: 'promotion_date', type: 'date', description: 'Promotion date' },
    { name: 'size', type: 'string', description: 'Size', variant: true },
  ],
});

const codes = (attributes: unknown) =>
  validateAttributes(schema, attributes).map((i) => i.code);

describe('validateAttributes', () => {
  it('accepts valid attributes with optional properties missing', () => {
    expect(validateAttributes(schema, { gender: 'girls' })).toEqual([]);
  });

  it('accepts every type in canonical form', () => {
    expect(
      validateAttributes(schema, {
        gender: 'boys',
        type: 't-shirt',
        weight: 1.5,
        organic: true,
        photo: 'https://example.com/a.jpg',
        tags: ['a', 'b'],
        promotion_date: '2026-10-15',
      }),
    ).toEqual([]);
  });

  it('rejects an undeclared key', () => {
    expect(codes({ gender: 'girls', color: 'red' })).toEqual([
      'undeclared_property',
    ]);
  });

  it('rejects the variant property inside attributes', () => {
    expect(codes({ gender: 'girls', size: '10' })).toEqual([
      'variant_in_attributes',
    ]);
  });

  it('rejects a wrong value type', () => {
    expect(codes({ gender: 'girls', type: 5 })).toEqual(['invalid_value']);
    expect(codes({ gender: 'girls', weight: '1.5' })).toEqual([
      'invalid_value',
    ]);
    expect(codes({ gender: 'girls', organic: 'yes' })).toEqual([
      'invalid_value',
    ]);
    expect(codes({ gender: 'girls', tags: ['a', 1] })).toEqual([
      'invalid_value',
    ]);
    expect(codes({ gender: 'girls', photo: 'not a url' })).toEqual([
      'invalid_value',
    ]);
    expect(codes({ gender: 'girls', type: null })).toEqual(['invalid_value']);
  });

  it('rejects a value outside the enum', () => {
    expect(codes({ gender: 'adults' })).toEqual(['value_not_allowed']);
  });

  it('accepts a valid ISO date and reads it back unchanged', () => {
    const attributes = { gender: 'girls', promotion_date: '2026-10-15' };
    expect(validateAttributes(schema, attributes)).toEqual([]);
    expect(attributes.promotion_date).toBe('2026-10-15');
  });

  it.each([
    '15/10/2026',
    '2026-02-31',
    '2026-13-01',
    '2026-10-15T00:00:00Z',
    '',
  ])('rejects date %j', (value) => {
    expect(codes({ gender: 'girls', promotion_date: value })).toEqual([
      'invalid_value',
    ]);
  });

  it('accepts a leap day and rejects a non-leap one', () => {
    expect(codes({ gender: 'girls', promotion_date: '2028-02-29' })).toEqual(
      [],
    );
    expect(codes({ gender: 'girls', promotion_date: '2027-02-29' })).toEqual([
      'invalid_value',
    ]);
  });

  it('rejects a missing required property', () => {
    expect(codes({ type: 't-shirt' })).toEqual(['missing_required']);
  });

  it('rejects attributes that are not an object', () => {
    expect(codes(null)).toEqual(['invalid_attributes']);
    expect(codes([])).toEqual(['invalid_attributes']);
    expect(codes('x')).toEqual(['invalid_attributes']);
  });

  it('reports every problem at once', () => {
    expect(codes({ type: 5, color: 'red' }).sort()).toEqual(
      ['invalid_value', 'missing_required', 'undeclared_property'].sort(),
    );
  });
});
