import type { Page } from 'puppeteer-core';
import { Locator } from '../../scrape/spec/selector-spec.js';
import {
  InvalidSpecError,
  SpecIssue,
  validateSelectorSpec,
} from '../../scrape/spec/spec-validator.js';
import { SelectorSpec } from '../../scrape/spec/selector-spec.js';

export const DEFAULT_OUTLINE_CHARS = 12_000;

/**
 * Runs in the page. A compact structural summary: tag, id, class names, a text
 * snippet, with runs of similar siblings collapsed so a product grid costs a
 * few lines rather than hundreds. Self-contained because it is serialized.
 */
export function outlineInPage(maxDepth: number): string {
  const lines: string[] = [];
  const skip = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'SVG',
    'PATH',
    'LINK',
    'META',
    'HEAD',
  ]);
  const signature = (el: Element) =>
    `${el.tagName}.${Array.from(el.classList).slice(0, 3).join('.')}`;
  const describe = (el: Element) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = Array.from(el.classList).slice(0, 4).join('.');
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    const attrs = ['href', 'src', 'data-testid', 'itemprop']
      .filter((a) => el.hasAttribute(a))
      .map((a) => `${a}=${(el.getAttribute(a) ?? '').slice(0, 50)}`)
      .join(' ');
    return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''}${attrs ? ' [' + attrs + ']' : ''}${text ? ' "' + text + '"' : ''}`;
  };
  const walk = (el: Element, depth: number) => {
    if (skip.has(el.tagName.toUpperCase())) return;
    lines.push(`${'  '.repeat(depth)}${describe(el)}`);
    if (depth >= maxDepth) return;
    const children = Array.from(el.children).filter(
      (c) => !skip.has(c.tagName.toUpperCase()),
    );
    let i = 0;
    while (i < children.length) {
      const sig = signature(children[i]);
      let run = 1;
      while (i + run < children.length && signature(children[i + run]) === sig)
        run++;
      walk(children[i], depth + 1);
      if (run > 1)
        lines.push(
          `${'  '.repeat(depth + 1)}... ${run - 1} more like the one above`,
        );
      i += run;
    }
  };
  walk(document.body, 0);
  return lines.join('\n');
}

/** Structural summary of the current page, truncated to `maxChars`. */
export async function outlinePage(
  page: Page,
  maxChars: number = DEFAULT_OUTLINE_CHARS,
): Promise<string> {
  const full = await page.evaluate(outlineInPage, 14);
  if (full.length <= maxChars) return full;
  return `${full.slice(0, maxChars)}\n... [outline truncated at ${maxChars} characters of ${full.length}]`;
}

export interface LocatorTestResult {
  count: number;
  samples: string[];
  error?: string;
}

/** Match count and the text of the first few matches for a CSS selector or XPath. */
export async function testLocator(
  page: Page,
  locator: Locator,
  options: { maxSamples?: number } = {},
): Promise<LocatorTestResult> {
  const maxSamples = options.maxSamples ?? 5;
  try {
    return await page.evaluate(
      (loc, max) => {
        const nodes: Node[] = [];
        if ('css' in loc)
          nodes.push(...Array.from(document.querySelectorAll(loc.css)));
        else {
          const snap = document.evaluate(
            loc.xpath,
            document,
            null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null,
          );
          for (let i = 0; i < snap.snapshotLength; i++)
            nodes.push(snap.snapshotItem(i)!);
        }
        return {
          count: nodes.length,
          samples: nodes
            .slice(0, max)
            .map((n) =>
              (n.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
            ),
        };
      },
      locator,
      maxSamples,
    );
  } catch (error) {
    return {
      count: 0,
      samples: [],
      error: (error as Error).message.slice(0, 200),
    };
  }
}

export type SubmitResult =
  { ok: true; spec: SelectorSpec } | { ok: false; errors: SpecIssue[] };

/** Validates a candidate; the errors go back to the agent as a repair round. */
export function submitSpec(candidate: unknown): SubmitResult {
  try {
    return { ok: true, spec: validateSelectorSpec(candidate) };
  } catch (error) {
    if (error instanceof InvalidSpecError)
      return { ok: false, errors: error.issues };
    throw error;
  }
}
