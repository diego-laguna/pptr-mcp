import { SelectorSpec } from '../../scrape/spec/selector-spec.js';
import { ResultItem } from '../../scrape/contracts/messages.js';
import { DiscoveryMode } from '../api/types.js';

const same = (a: unknown, b: unknown) =>
  JSON.stringify(sort(a)) === JSON.stringify(sort(b));
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, v]) => [k, sort(v)]),
    );
  return value;
}

export interface DiffInput {
  mode: Exclude<DiscoveryMode, 'full'>;
  base: SelectorSpec;
  candidate: SelectorSpec;
  targets: string[];
  variantProperty: string | null;
}

/**
 * Structural check, not a model promise: apart from the targeted bindings the
 * candidate must equal the base byte for byte. Returns the violations; any
 * violation makes the candidate `invalid_output`.
 */
export function checkStructuralDiff(input: DiffInput): string[] {
  const { mode, base, candidate, targets, variantProperty } = input;
  const problems: string[] = [];
  const targeted = new Set(targets);

  for (const key of [
    'formatVersion',
    'site',
    'steps',
    'pagination',
    'items',
    'system',
  ] as const) {
    if (!same(base[key], candidate[key]))
      problems.push(`${key} must be identical to the base spec`);
  }

  // Properties: only targeted ones may differ.
  const names = new Set([
    ...Object.keys(base.properties),
    ...Object.keys(candidate.properties),
  ]);
  for (const name of names) {
    const before = base.properties[name];
    const after = candidate.properties[name];
    if (same(before, after)) continue;
    if (!targeted.has(name)) {
      problems.push(`binding "${name}" was changed but is not a target`);
    } else if (mode === 'incremental' && before !== undefined) {
      problems.push(`binding "${name}" already exists and must not change`);
    }
  }
  if (mode === 'incremental') {
    for (const name of Object.keys(base.properties))
      if (candidate.properties[name] === undefined)
        problems.push(`binding "${name}" was removed`);
  }

  // The variant bindings are the variant property's binding.
  if (!same(base.variants, candidate.variants)) {
    const variantTargeted =
      variantProperty !== null && targeted.has(variantProperty);
    if (!variantTargeted)
      problems.push(
        'variants were changed but the variant property is not a target',
      );
    else if (mode === 'incremental' && base.variants !== undefined)
      problems.push('variants already exist and must not change');
  }
  return problems;
}

export interface Regression {
  property: string;
  link: string;
  before: unknown;
  after: unknown;
}

/**
 * Compares typed values of the bindings that must not change, matching items
 * by link on the same pages. Items the candidate did not reach are not compared;
 * a binding whose values differ on a common item is a regression.
 */
export function checkRegression(
  baseItems: ResultItem[],
  candidateItems: ResultItem[],
  preserved: string[],
): Regression[] {
  const byLink = new Map(candidateItems.map((i) => [i.raw.link, i]));
  const found: Regression[] = [];
  for (const before of baseItems) {
    const after = byLink.get(before.raw.link);
    if (!after) continue;
    for (const property of preserved) {
      if (!same(before.value[property], after.value[property]))
        found.push({
          property,
          link: String(before.raw.link),
          before: before.value[property],
          after: after.value[property],
        });
    }
  }
  return found;
}

/** Properties whose values must stay identical: everything the base binds that is not targeted. */
export function preservedProperties(
  base: SelectorSpec,
  targets: string[],
): string[] {
  const targeted = new Set(targets);
  return [
    'name',
    'link',
    'price',
    'thumbnail_url',
    ...Object.keys(base.properties).filter((n) => !targeted.has(n)),
  ];
}

export interface BindingComparison {
  property: string;
  oldMatches: number;
  oldParseRate: number | null;
  newMatches: number;
  newParseRate: number | null;
}

/** Old versus new binding for each targeted property, for the repair evidence. */
export function compareBindings(
  targets: string[],
  oldRun: {
    matchCounts: Record<string, number>;
    parseRates: Record<string, number>;
  },
  newRun: {
    matchCounts: Record<string, number>;
    parseRates: Record<string, number>;
  },
): BindingComparison[] {
  return targets.map((property) => ({
    property,
    oldMatches: oldRun.matchCounts[property] ?? 0,
    oldParseRate: oldRun.parseRates[property] ?? null,
    newMatches: newRun.matchCounts[property] ?? 0,
    newParseRate: newRun.parseRates[property] ?? null,
  }));
}
