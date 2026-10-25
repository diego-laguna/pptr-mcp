import type { CatalogSchema } from '../../catalog/schema/property-types.js';
import { snapshotFromSchema } from './snapshot.js';

const schema: CatalogSchema = {
  properties: [
    {
      name: 'size',
      type: 'string',
      description: 'Size',
      required: true,
      filterable: true,
      variant: true,
    },
    {
      name: 'gender',
      type: 'enum',
      description: 'Gender',
      required: false,
      filterable: true,
      values: ['boys', 'girls'],
      example: 'boys',
    },
  ],
};

describe('snapshotFromSchema', () => {
  it('drops filterable and names the flagged variant property', () => {
    const snapshot = snapshotFromSchema(schema, 3);
    expect(snapshot.schemaVersion).toBe(3);
    expect(snapshot.variantProperty).toBe('size');
    expect(snapshot.properties[0]).toEqual({
      name: 'size',
      type: 'string',
      description: 'Size',
      required: true,
    });
    expect(snapshot.properties[1]).toEqual({
      name: 'gender',
      type: 'enum',
      description: 'Gender',
      required: false,
      values: ['boys', 'girls'],
      example: 'boys',
    });
    expect(JSON.stringify(snapshot)).not.toContain('filterable');
  });

  it('has no variant property when none is flagged', () => {
    const plain = {
      properties: schema.properties.map(({ variant: _v, ...p }) => p),
    };
    expect(snapshotFromSchema(plain, 1).variantProperty).toBeNull();
  });

  it('prefers the stored variant column over the flag, including null', () => {
    expect(snapshotFromSchema(schema, 1, 'gender').variantProperty).toBe(
      'gender',
    );
    expect(snapshotFromSchema(schema, 1, null).variantProperty).toBeNull();
  });
});
