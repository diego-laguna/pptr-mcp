import type { Page } from 'puppeteer-core';
import { SelectorSpec } from '../../scrape/spec/selector-spec.js';
import { DiscoveryMode } from '../api/types.js';
import {
  BindingComparison,
  checkRegression,
  checkStructuralDiff,
  compareBindings,
  preservedProperties,
} from './diff-checks.js';
import {
  Check,
  evaluateRun,
  runForVerification,
  Verification,
  VerifyOptions,
} from './verifier.js';

export type CandidateEvaluation =
  | {
      kind: 'ok';
      verification: Verification;
      comparisons?: BindingComparison[];
    }
  | { kind: 'invalid_output'; problems: string[] }
  | {
      kind: 'verification_failed';
      verification: Verification;
      details: string;
      comparisons?: BindingComparison[];
    };

export interface EvaluateArgs {
  mode: DiscoveryMode;
  candidate: SelectorSpec;
  base: SelectorSpec | null;
  targets: string[];
  variantProperty: string | null;
  options: VerifyOptions;
}

/**
 * Everything that decides whether a candidate is offered: the structural diff
 * for incremental and repair, a live run with the production runner, the
 * thresholds, and the regression check against the base on the same pages.
 */
export async function evaluateCandidate(
  page: Page,
  args: EvaluateArgs,
): Promise<CandidateEvaluation> {
  const { mode, candidate, base, targets, variantProperty, options } = args;

  if (mode !== 'full') {
    if (!base) throw new Error(`${mode} needs a base spec`);
    const problems = checkStructuralDiff({
      mode,
      base,
      candidate,
      targets,
      variantProperty,
    });
    if (problems.length > 0) return { kind: 'invalid_output', problems };
  }

  const run = await runForVerification(page, candidate, options);
  const verification = evaluateRun(run, candidate, options.thresholds);
  const extraChecks: Check[] = [];
  let comparisons: BindingComparison[] | undefined;

  if (mode !== 'full' && base) {
    // Only the targeted bindings answer to the parse-rate threshold; the rest are held to equality.
    verification.checks = verification.checks.filter(
      (c) =>
        !c.name.startsWith('parse_rate_') ||
        targets.includes(c.name.slice('parse_rate_'.length)),
    );

    const boundTargets = targets.filter(
      (t) => candidate.properties[t] !== undefined,
    );
    if (mode === 'repair' && boundTargets.length === 0) {
      extraChecks.push({
        name: 'repaired_any',
        passed: false,
        detail: 'none of the targeted properties was repaired',
      });
    }

    const baseRun = await runForVerification(page, base, options);
    const baseVerification = evaluateRun(baseRun, base, options.thresholds);
    const regressions = checkRegression(
      baseRun.items,
      run.items,
      preservedProperties(base, targets),
    );
    extraChecks.push({
      name: 'no_regression',
      passed: regressions.length === 0,
      detail:
        regressions.length === 0
          ? 'existing bindings yield the same typed values as the base spec'
          : `existing values changed: ${regressions
              .slice(0, 5)
              .map(
                (r) =>
                  `${r.property} on ${r.link}: ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}`,
              )
              .join('; ')}`,
    });
    if (mode === 'repair')
      comparisons = compareBindings(targets, baseVerification, verification);
  }

  verification.checks.push(...extraChecks);
  verification.passed = verification.checks.every((c) => c.passed);
  if (verification.passed) return { kind: 'ok', verification, comparisons };
  return {
    kind: 'verification_failed',
    verification,
    comparisons,
    details: verification.checks
      .filter((c) => !c.passed)
      .map((c) => `- ${c.name}: ${c.detail}`)
      .join('\n'),
  };
}
