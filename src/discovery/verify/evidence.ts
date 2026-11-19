import { ResultItem } from '../../scrape/contracts/messages.js';
import { SelectorSpec } from '../../scrape/spec/selector-spec.js';
import { BindingComparison } from './diff-checks.js';
import { detectStability, StabilityWarning } from './stability.js';
import { Check, Verification } from './verifier.js';

export const MAX_SAMPLES = 20;

export interface GuardEvent {
  kind:
    | 'blocked_address'
    | 'blocked_domain'
    | 'blocked_scheme'
    | 'blocked_download';
  url: string;
  detail?: string;
}

export interface UnresolvedProperty {
  property: string;
  reason: string;
}

export interface ScreenshotRecord {
  key: string;
  page: string;
  /** Bindings that matched nothing on this page and so are not drawn. */
  notHighlighted: string[];
}

export interface Evidence {
  outcome: 'candidate' | 'failed';
  mode: string;
  targets: string[];
  checks: Check[];
  samples: ResultItem[];
  matchCounts: Record<string, number>;
  parseRates: Record<string, number>;
  stabilityWarnings: StabilityWarning[];
  unresolved: UnresolvedProperty[];
  guardEvents: GuardEvent[];
  notes: string[];
  comparisons?: BindingComparison[];
  screenshots: ScreenshotRecord[];
}

export function buildEvidence(input: {
  outcome: Evidence['outcome'];
  mode: string;
  targets: string[];
  spec: SelectorSpec | null;
  verification: Verification | null;
  unresolved: UnresolvedProperty[];
  guardEvents: GuardEvent[];
  notes: string[];
  comparisons?: BindingComparison[];
  screenshots?: ScreenshotRecord[];
  extraChecks?: Check[];
}): Evidence {
  const v = input.verification;
  return {
    outcome: input.outcome,
    mode: input.mode,
    targets: input.targets,
    checks: [...(v?.checks ?? []), ...(input.extraChecks ?? [])],
    samples: (v?.items ?? []).slice(0, MAX_SAMPLES),
    matchCounts: v?.matchCounts ?? {},
    parseRates: v?.parseRates ?? {},
    stabilityWarnings: input.spec ? detectStability(input.spec) : [],
    unresolved: input.unresolved,
    guardEvents: input.guardEvents,
    notes: input.notes,
    ...(input.comparisons ? { comparisons: input.comparisons } : {}),
    screenshots: input.screenshots ?? [],
  };
}

/** Properties in scope that the candidate leaves unbound, with the agent's reason when given. */
export function unresolvedOf(
  spec: SelectorSpec,
  inScope: string[],
  variantProperty: string | null,
  reasons: UnresolvedProperty[],
): UnresolvedProperty[] {
  const bound = new Set(Object.keys(spec.properties));
  if (spec.variants && variantProperty) bound.add(variantProperty);
  return inScope
    .filter((name) => !bound.has(name))
    .map((property) => ({
      property,
      reason:
        reasons.find((r) => r.property === property)?.reason ??
        'no element was located with confidence',
    }));
}
