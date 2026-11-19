import type { Browser, Page } from 'puppeteer-core';
import { PreviewLimits } from '../contracts/messages.js';
import { Locator, SelectorSpec } from '../spec/selector-spec.js';
import { extractInPage, extractionRequest, RawItem } from './extract.js';

export class DeadlineExceededError extends Error {
  constructor() {
    super('deadline exceeded');
    this.name = 'DeadlineExceededError';
  }
}

export interface RunOptions {
  /** Epoch ms after which the run must have stopped. */
  deadline: number;
  /** Stop this long before the deadline so cleanup can finish. */
  safetyMarginMs: number;
  limits?: PreviewLimits;
  now?: () => number;
}

export interface RawRun {
  finished: boolean;
  pages: number;
  rawItems: RawItem[];
}

const SETTLE_MS = 150;
const STEP_TIMEOUT_MS = 30_000;

const selectorOf = (locator: Locator) =>
  'css' in locator ? locator.css : `xpath/${locator.xpath}`;

/** Executes a validated spec in an already open page. Never throws for a deadline; it reports an unfinished run. */
export async function runSpec(
  page: Page,
  spec: SelectorSpec,
  options: RunOptions,
): Promise<RawRun> {
  const now = options.now ?? Date.now;
  const stopAt = options.deadline - options.safetyMarginMs;
  const rawItems: RawItem[] = [];
  const seen = new Set<string>();
  let pages = 0;

  const remaining = () => stopAt - now();
  const guard = async <T>(
    work: (timeout: number) => Promise<T>,
  ): Promise<T> => {
    const left = remaining();
    if (left <= 0) throw new DeadlineExceededError();
    const timeout = Math.min(STEP_TIMEOUT_MS, left);
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceededError()), left);
    });
    try {
      return await Promise.race([work(timeout), expiry]);
    } finally {
      clearTimeout(timer);
    }
  };

  const maxItems = options.limits?.maxItems ?? Infinity;
  const pageCap = Math.min(
    options.limits?.maxPages ?? Infinity,
    spec.pagination?.maxPages ?? 1,
  );

  const collect = async (): Promise<number> => {
    const batch = await guard(() =>
      page.evaluate(extractInPage, extractionRequest(spec)),
    );
    let added = 0;
    for (const item of batch) {
      const key = item.system.link ?? JSON.stringify(item.system);
      if (seen.has(key)) continue;
      seen.add(key);
      rawItems.push(item);
      added++;
      if (rawItems.length >= maxItems) break;
    }
    return added;
  };
  const full = () => rawItems.length >= maxItems;

  const signature = async (): Promise<string> => {
    // A click may navigate while we look; retry until the new document answers.
    for (let attempt = 0; ; attempt++) {
      try {
        return await page.evaluate(
          () =>
            `${location.href}|${document.body?.innerText.length}|${document.body?.childElementCount}`,
        );
      } catch (error) {
        if (attempt >= 20) throw error;
        await new Promise((r) => setTimeout(r, SETTLE_MS));
      }
    }
  };

  try {
    for (const step of spec.steps) {
      await guard(async (timeout) => {
        switch (step.type) {
          case 'open_url':
            await page.goto(step.url, {
              waitUntil: 'domcontentloaded',
              timeout,
            });
            break;
          case 'click':
            await page
              .locator(selectorOf(step.locator))
              .setTimeout(timeout)
              .click();
            break;
          case 'wait_for':
            await page.waitForSelector(selectorOf(step.locator), {
              timeout: Math.min(timeout, step.timeoutMs ?? timeout),
            });
            break;
          case 'scroll':
            for (let i = 0; i < (step.times ?? 1); i++) {
              await page.evaluate(() =>
                window.scrollTo(0, document.body.scrollHeight),
              );
              await new Promise((r) => setTimeout(r, SETTLE_MS));
            }
            break;
        }
      });
    }

    const pagination = spec.pagination;
    if (!pagination) {
      await collect();
      pages = 1;
    } else if (pagination.mode === 'next_button') {
      for (let p = 1; p <= pageCap; p++) {
        await collect();
        pages = p;
        if (full() || p === pageCap) break;
        const next = await guard(() => page.$(selectorOf(pagination.locator)));
        if (!next) break;
        const before = await guard(signature);
        await guard(async (timeout) => {
          await next.click();
          const until = Date.now() + Math.min(timeout, 5000);
          while (Date.now() < until && (await signature()) === before)
            await new Promise((r) => setTimeout(r, SETTLE_MS));
        });
        if ((await guard(signature)) === before) break;
      }
    } else if (pagination.mode === 'url_template') {
      for (let p = 0; p < pageCap; p++) {
        const url = pagination.template.replace(
          '{page}',
          String(pagination.startPage + p),
        );
        await guard((timeout) =>
          page.goto(url, { waitUntil: 'domcontentloaded', timeout }),
        );
        const added = await collect();
        pages = p + 1;
        if (added === 0 || full()) break;
      }
    } else {
      const scrolls = Math.min(
        pagination.maxScrolls,
        options.limits?.maxPages ?? Infinity,
      );
      await collect();
      pages = 1;
      for (let s = 0; s < scrolls && !full(); s++) {
        const before = await guard(() =>
          page.evaluate(() => document.body.scrollHeight),
        );
        await guard(async () => {
          await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight),
          );
          await new Promise((r) => setTimeout(r, SETTLE_MS * 2));
        });
        const after = await guard(() =>
          page.evaluate(() => document.body.scrollHeight),
        );
        const added = await collect();
        pages = s + 2;
        if (after === before && added === 0) break;
      }
    }
    return { finished: true, pages, rawItems };
  } catch (error) {
    if (error instanceof DeadlineExceededError || isTimeout(error))
      return { finished: false, pages, rawItems };
    throw error;
  }
}

function isTimeout(error: unknown): boolean {
  return (error as { name?: string })?.name === 'TimeoutError';
}

export interface BrowserLauncher {
  launch(): Promise<Browser>;
}

/** Opens a browser, runs the spec, and always closes the browser, even after a failure or timeout. */
export async function runWithBrowser(
  launcher: BrowserLauncher,
  spec: SelectorSpec,
  options: RunOptions,
): Promise<RawRun> {
  const browser = await launcher.launch();
  try {
    const page = await browser.newPage();
    return await runSpec(page, spec, options);
  } finally {
    const child = browser.process();
    await browser.close().catch(() => undefined);
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }
}
