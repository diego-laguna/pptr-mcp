import type { Page } from 'puppeteer-core';
import { schemaMismatches } from '../../scrape/runner/schema-check.js';
import { Locator, SelectorSpec } from '../../scrape/spec/selector-spec.js';
import { DiscoveryMessage } from '../api/types.js';
import { outlinePage, submitSpec, testLocator } from '../tools/page-tools.js';
import { BindingComparison } from '../verify/diff-checks.js';
import { evaluateCandidate } from '../verify/candidate-evaluator.js';
import { UnresolvedProperty } from '../verify/evidence.js';
import { Verification, VerifyThresholds } from '../verify/verifier.js';
import { BrowsingGuard } from './browsing-guard.js';

export const MAX_REPAIR_ROUNDS = 3;
const TEXT_LIMIT = 4000;

export interface AcceptedCandidate {
  spec: SelectorSpec;
  verification: Verification;
  comparisons?: BindingComparison[];
  unresolved: UnresolvedProperty[];
  notes: string[];
}

export interface SessionConfig {
  message: DiscoveryMessage;
  base: SelectorSpec | null;
  page: Page;
  guard: BrowsingGuard;
  deadline: number;
  previewLimits: { maxPages: number; maxItems: number };
  thresholds?: Partial<VerifyThresholds>;
  maxRepairRounds?: number;
  /** Called once the candidate is accepted or the repair rounds are used up. */
  onFinished?: () => void;
}

/** Page text is attacker-controlled; the wrapper tells the model (and the reader) it is data. */
const asData = (label: string, body: string) =>
  `<untrusted_page_data source="${label}">\n${body.slice(0, TEXT_LIMIT)}\n</untrusted_page_data>`;

/**
 * The state and the handlers behind the agent's tools. The only way a
 * candidate comes into existence is `submitSpec` returning accepted; free text
 * from the model is never parsed into a spec.
 */
export class DiscoverySession {
  accepted: AcceptedCandidate | null = null;
  verificationFailures = 0;
  exhausted = false;
  lastFailureDetail: string | null = null;
  navigationErrors: string[] = [];
  successfulNavigations = 0;
  blockedStatuses: number[] = [];
  readonly notes: string[] = [];

  constructor(private readonly config: SessionConfig) {}

  /** The spec an incremental or repair attempt starts from. */
  get baseSpec(): SelectorSpec | null {
    return this.config.base;
  }

  get maxRounds() {
    return this.config.maxRepairRounds ?? MAX_REPAIR_ROUNDS;
  }

  private get page() {
    return this.config.page;
  }

  // --- browser tools ---------------------------------------------------

  async navigate(url: string): Promise<string> {
    try {
      const response = await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      const status = response?.status() ?? 0;
      if ([401, 403, 429, 503].includes(status))
        this.blockedStatuses.push(status);
      else this.successfulNavigations++;
      return `Loaded ${this.page.url()} (HTTP ${status}). Title: ${asData('title', await this.page.title())}`;
    } catch (error) {
      const guarded =
        this.config.guard.events.length > 0
          ? ' (the browsing guard blocked a request)'
          : '';
      this.navigationErrors.push((error as Error).message);
      return `Navigation failed: ${(error as Error).message.slice(0, 200)}${guarded}`;
    }
  }

  async click(locator: Locator): Promise<string> {
    try {
      const selector =
        'css' in locator ? locator.css : `xpath/${locator.xpath}`;
      await this.page.locator(selector).setTimeout(10_000).click();
      await new Promise((r) => setTimeout(r, 300));
      return `Clicked. Now at ${this.page.url()}`;
    } catch (error) {
      return `Click failed: ${(error as Error).message.slice(0, 200)}`;
    }
  }

  async scroll(times = 1): Promise<string> {
    for (let i = 0; i < Math.min(times, 10); i++) {
      await this.page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight),
      );
      await new Promise((r) => setTimeout(r, 300));
    }
    return 'Scrolled to the bottom.';
  }

  async pageText(selector?: string): Promise<string> {
    const text = await this.page.evaluate((sel) => {
      const el = sel ? document.querySelector(sel) : document.body;
      return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    }, selector);
    return asData(selector ?? 'body', text);
  }

  // --- spec tools --------------------------------------------------------

  async outline(): Promise<string> {
    return asData('outline', await outlinePage(this.page, 12_000));
  }

  async testLocator(locator: Locator): Promise<string> {
    const r = await testLocator(this.page, locator);
    if (r.error) return `Locator error: ${r.error}`;
    return `${r.count} matches. First samples: ${asData('samples', JSON.stringify(r.samples))}`;
  }

  /** Validates, checks the schema, verifies live, and accepts or returns what to fix. */
  async submit(input: {
    spec: unknown;
    unresolved?: UnresolvedProperty[];
    notes?: string;
  }): Promise<string> {
    if (this.accepted) return 'A candidate was already accepted. Stop.';
    if (this.exhausted) return 'No repair rounds are left. Stop.';

    const submitted = submitSpec(input.spec);
    if (!submitted.ok) {
      return this.fail(
        `The spec is not valid:\n${submitted.errors.map((e) => `- ${e.path}: ${e.message}`).join('\n')}`,
      );
    }
    const spec = submitted.spec;
    const { message } = this.config;
    const mismatches = schemaMismatches(spec, {
      properties: message.snapshot.properties.map((p) => p.name),
      variantProperty: message.snapshot.variantProperty,
    });
    if (mismatches.length > 0)
      return this.fail(
        `The spec does not fit the schema:\n- ${mismatches.join('\n- ')}`,
      );

    const evaluation = await evaluateCandidate(this.page, {
      mode: message.mode,
      candidate: spec,
      base: this.config.base,
      targets: message.targetProperties,
      variantProperty: message.snapshot.variantProperty,
      options: {
        deadline: this.config.deadline,
        limits: this.config.previewLimits,
        thresholds: this.config.thresholds,
      },
    });

    if (evaluation.kind === 'invalid_output')
      return this.fail(
        `The candidate changes what it must not:\n- ${evaluation.problems.join('\n- ')}`,
      );
    if (evaluation.kind === 'verification_failed')
      return this.fail(
        `Live verification failed:\n${evaluation.details}`,
        evaluation.details,
      );

    this.accepted = {
      spec,
      verification: evaluation.verification,
      comparisons: evaluation.comparisons,
      unresolved: input.unresolved ?? [],
      notes: [...this.notes, ...(input.notes ? [input.notes] : [])],
    };
    this.config.onFinished?.();
    return `Accepted: ${evaluation.verification.items.length} items extracted and all checks passed. You are done; stop now.`;
  }

  private fail(text: string, detail?: string): string {
    this.verificationFailures++;
    this.lastFailureDetail = detail ?? text;
    if (this.verificationFailures > this.maxRounds) {
      this.exhausted = true;
      this.config.onFinished?.();
      return `${text}\n\nNo repair rounds are left. Stop.`;
    }
    return `${text}\n\nYou have ${this.maxRounds - this.verificationFailures + 1} attempt(s) left.`;
  }
}
