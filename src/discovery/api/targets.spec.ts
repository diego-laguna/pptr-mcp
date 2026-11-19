import { validSpec } from '../../scrape/spec/spec-fixtures.js';
import { resolveTargets, TargetError } from './targets.js';
import { SchemaSnapshot } from './types.js';

const prop = (name: string) => ({
  name,
  type: 'string' as const,
  description: name,
  required: false,
});
const snapshot = (
  names: string[],
  variantProperty: string | null = null,
): SchemaSnapshot => ({
  schemaVersion: 1,
  properties: names.map(prop),
  variantProperty,
});
const base = () => validSpec() as never; // binds `launch`

describe('resolveTargets', () => {
  it('returns no targets for a full discovery and rejects named ones', () => {
    const args = {
      snapshot: snapshot(['launch']),
      base: null,
      failingFromLastScrape: [],
    };
    expect(
      resolveTargets({ ...args, mode: 'full', requested: undefined }),
    ).toEqual([]);
    expect(() =>
      resolveTargets({ ...args, mode: 'full', requested: ['launch'] }),
    ).toThrow(TargetError);
  });

  it('defaults incremental targets to every unbound property', () => {
    expect(
      resolveTargets({
        mode: 'incremental',
        requested: undefined,
        base: base(),
        snapshot: snapshot(['launch', 'fabric', 'season']),
        failingFromLastScrape: [],
      }),
    ).toEqual(['fabric', 'season']);
  });

  it('rejects an incremental target the base already binds', () => {
    expect(() =>
      resolveTargets({
        mode: 'incremental',
        requested: ['launch'],
        base: base(),
        snapshot: snapshot(['launch', 'fabric']),
        failingFromLastScrape: [],
      }),
    ).toThrow(/already bound/);
  });

  it('rejects an incremental request when nothing is unbound', () => {
    expect(() =>
      resolveTargets({
        mode: 'incremental',
        requested: undefined,
        base: base(),
        snapshot: snapshot(['launch']),
        failingFromLastScrape: [],
      }),
    ).toThrow(TargetError);
  });

  it('treats the variant property as bound when variants are bound', () => {
    const spec = validSpec();
    spec.variants = {
      locator: { css: 'li' },
      value: { source: 'text' },
      price: { source: 'text' },
      available: { source: 'text' },
    };
    expect(
      resolveTargets({
        mode: 'incremental',
        requested: undefined,
        base: spec as never,
        snapshot: snapshot(['launch', 'size', 'fabric'], 'size'),
        failingFromLastScrape: [],
      }),
    ).toEqual(['fabric']);
  });

  it("defaults repair targets to the last scrape's failing properties that the spec binds", () => {
    expect(
      resolveTargets({
        mode: 'repair',
        requested: undefined,
        base: base(),
        snapshot: snapshot(['launch', 'color']),
        failingFromLastScrape: ['launch', 'color'],
      }),
    ).toEqual(['launch']);
  });

  it('rejects repair without known failures, an unbound property or a system field', () => {
    const args = {
      mode: 'repair' as const,
      base: base(),
      snapshot: snapshot(['launch', 'color']),
    };
    expect(() =>
      resolveTargets({
        ...args,
        requested: undefined,
        failingFromLastScrape: [],
      }),
    ).toThrow(/no failing/);
    expect(() =>
      resolveTargets({
        ...args,
        requested: ['color'],
        failingFromLastScrape: [],
      }),
    ).toThrow(/not bound/);
    expect(() =>
      resolveTargets({
        ...args,
        requested: ['price'],
        failingFromLastScrape: [],
      }),
    ).toThrow(/system field/);
    expect(() =>
      resolveTargets({
        ...args,
        requested: ['ghost'],
        failingFromLastScrape: [],
      }),
    ).toThrow(/not a property/);
  });
});
