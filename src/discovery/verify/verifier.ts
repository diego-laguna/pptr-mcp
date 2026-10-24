import type { Page } from 'puppeteer-core';
import { ResultItem, RunResult } from '../../scrape/contracts/messages.js';
import { parseRates } from '../../scrape/api/run-finalizer.js';
import { buildItems, RawItem } from '../../scrape/runner/extract.js';
import { runSpec } from '../../scrape/runner/runner.js';
import {
  SelectorSpec,
  SYSTEM_FIELDS,
} from '../../scrape/spec/selector-spec.js';

export interface VerifyThresholds {
  minItems: number;
  /** Share of items that must carry each system field. */
  systemFieldCoverage: number;
  /** Share of the links that must be distinct absolute URLs. */
  distinctLinks: number;
  /** Share of present raw values that must parse, per bound property. */
  minParseRate: number;
}

export const DEFAULT_THRESHOLDS: VerifyThresholds = {
  minItems: 5,
  systemFieldCoverage: 0.95,
  distinctLinks: 0.95,
  minParseRate: 0.8,
};

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface Verification {
  passed: boolean;
  checks: Check[];
  finished: boolean;
  rawItems: RawItem[];
  items: ResultItem[];
  skipped: number;
  parseRates: Record<string, number>;
  /** Items with a raw value, per binding name. */
  matchCounts: Record<string, number>;
}

export interface VerifyOptions {
  deadline: number;
  limits: { maxPages: number; maxItems: number };
  thresholds?: Partial<VerifyThresholds>;
}

/** Runs the spec once with the production runner within preview limits. */
export async function runForVerification(
  page: Page,
  spec: SelectorSpec,
  options: VerifyOptions,
) {
  const raw = await runSpec(page, spec, {
    deadline: options.deadline,
    safetyMarginMs: 0,
    limits: options.limits,
  });
  const built = buildItems(raw.rawItems, spec);
  return { ...raw, ...built };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Evaluates a run against the thresholds; nothing here trusts the agent's own claims. */
export function evaluateRun(
  run: {
    finished: boolean;
    rawItems: RawItem[];
    items: ResultItem[];
    skipped: number;
    pages: number;
  },
  spec: SelectorSpec,
  thresholds: Partial<VerifyThresholds> = {},
): Verification {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const checks: Check[] = [];
  const total = run.rawItems.length;

  checks.push({
    name: 'finished',
    passed: run.finished,
    detail: run.finished
      ? 'the run finished'
      : 'the run did not finish within its time limit',
  });
  checks.push({
    name: 'item_count',
    passed: total >= t.minItems,
    detail: `${total} items extracted, at least ${t.minItems} required`,
  });

  for (const field of SYSTEM_FIELDS) {
    const have = run.rawItems.filter((i) => i.system[field]).length;
    const share = total === 0 ? 0 : have / total;
    checks.push({
      name: `system_field_${field}`,
      passed: share >= t.systemFieldCoverage,
      detail: `${field} present on ${pct(share)} of items (${have}/${total}), at least ${pct(t.systemFieldCoverage)} required`,
    });
  }

  const links = run.rawItems
    .map((i) => i.system.link)
    .filter((l): l is string => !!l);
  const absolute = links.filter((l) => /^https?:\/\//i.test(l));
  const distinct = new Set(absolute).size;
  const linkShare = links.length === 0 ? 0 : distinct / links.length;
  checks.push({
    name: 'distinct_absolute_links',
    passed: linkShare >= t.distinctLinks,
    detail: `${distinct} distinct absolute links among ${links.length} (${pct(linkShare)}), at least ${pct(t.distinctLinks)} required`,
  });

  const result = { items: run.items } as RunResult;
  const rates = parseRates(result);
  const parseRatesOut: Record<string, number> = {};
  for (const name of Object.keys(spec.properties)) {
    const rate = rates.get(name);
    if (rate === undefined) continue; // no raw text at all: nothing to parse, reported as match count 0
    parseRatesOut[name] = rate;
    checks.push({
      name: `parse_rate_${name}`,
      passed: rate >= t.minParseRate,
      detail: `${name} parsed for ${pct(rate)} of items with raw text, at least ${pct(t.minParseRate)} required`,
    });
  }

  const matchCounts: Record<string, number> = {};
  for (const field of SYSTEM_FIELDS)
    matchCounts[field] = run.rawItems.filter((i) => i.system[field]).length;
  for (const name of Object.keys(spec.properties))
    matchCounts[name] = run.rawItems.filter((i) => i.properties[name]).length;

  return {
    passed: checks.every((c) => c.passed),
    checks,
    finished: run.finished,
    rawItems: run.rawItems,
    items: run.items,
    skipped: run.skipped,
    parseRates: parseRatesOut,
    matchCounts,
  };
}

export async function verifyCandidate(
  page: Page,
  spec: SelectorSpec,
  options: VerifyOptions,
): Promise<Verification> {
  return evaluateRun(
    await runForVerification(page, spec, options),
    spec,
    options.thresholds,
  );
}

/** Human-readable failures, handed back to the agent as a repair round. */
export function describeFailures(v: Verification): string {
  return v.checks
    .filter((c) => !c.passed)
    .map((c) => `- ${c.name}: ${c.detail}`)
    .join('\n');
}
