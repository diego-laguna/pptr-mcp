import { RawItem } from '../../scrape/runner/extract.js';
import { validateSelectorSpec } from '../../scrape/spec/spec-validator.js';
import { validSpec } from '../../scrape/spec/spec-fixtures.js';
import { evaluateRun } from './verifier.js';

const spec = validateSelectorSpec(validSpec());

function rawItems(count: number, thumbnail: (n: number) => string | null) {
  return Array.from({ length: count }, (_, n): RawItem => ({
    system: {
      name: `Product ${n}`,
      link: `https://shop.example/p/${n}`,
      price: '$10',
      thumbnail_url: thumbnail(n),
    },
    properties: {},
    variants: [],
  }));
}

function evaluate(items: RawItem[]) {
  return evaluateRun(
    { finished: true, rawItems: items, items: [], skipped: 0, pages: 1 },
    spec,
  );
}

const thumbCheck = (v: ReturnType<typeof evaluate>) =>
  v.checks.find((c) => c.name === 'distinct_thumbnails')!;

describe('distinct_thumbnails check', () => {
  it('passes when every item has its own image', () => {
    const v = evaluate(rawItems(20, (n) => `https://cdn.example/img/${n}.jpg`));
    expect(thumbCheck(v).passed).toBe(true);
  });

  it('passes when a few items share an image', () => {
    const v = evaluate(
      rawItems(20, (n) => `https://cdn.example/img/${n % 18}.jpg`),
    );
    expect(thumbCheck(v).passed).toBe(true);
  });

  it('fails when every item carries the same badge or placeholder image', () => {
    const v = evaluate(rawItems(20, () => 'https://cdn.example/badge.svg'));
    const check = thumbCheck(v);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain('1 distinct thumbnail URLs among 20');
    expect(v.passed).toBe(false);
  });

  it('fails when no item has a thumbnail', () => {
    const v = evaluate(rawItems(20, () => null));
    expect(thumbCheck(v).passed).toBe(false);
  });
});
