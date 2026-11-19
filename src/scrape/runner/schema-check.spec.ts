import { validSpec } from '../spec/spec-fixtures.js';
import { schemaMismatches, schemaShapeOf } from './schema-check.js';

const check = (spec: unknown, names: string[], variant?: string) =>
  schemaMismatches(
    spec as never,
    schemaShapeOf({
      properties: names.map((name) => ({
        name,
        type: 'string',
        description: name,
        required: false,
        filterable: false,
        ...(name === variant ? { variant: true as const } : {}),
      })),
    }),
  );

describe('schemaMismatches', () => {
  it('passes when every bound property is declared', () => {
    expect(check(validSpec(), ['launch'])).toEqual([]);
  });

  it('flags a property renamed after the spec was written', () => {
    expect(check(validSpec(), ['release'])).toEqual([
      expect.stringContaining('"launch"'),
    ]);
  });

  it('allows a declared property the spec does not bind', () => {
    expect(check(validSpec(), ['launch', 'color'])).toEqual([]);
  });

  it('flags variants without a variant property', () => {
    const spec = validSpec();
    spec.variants = {
      locator: { css: 'li' },
      value: { source: 'text' },
      price: { source: 'text' },
      available: { source: 'text' },
    };
    expect(check(spec, ['launch'])).toHaveLength(1);
  });

  it('flags the variant property bound as a plain property', () => {
    expect(check(validSpec(), ['launch'], 'launch')).toHaveLength(1);
  });
});
