import { existsSync } from 'node:fs';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { validSpec } from '../../scrape/spec/spec-fixtures.js';
import { outlinePage, submitSpec, testLocator } from './page-tools.js';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

describe.skipIf(!existsSync(chrome))('spec tools on saved HTML', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox'],
    });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser.close();
  });

  const grid = (n: number) =>
    `<html><body><main id="catalog">${Array.from({ length: n }, (_, i) => `<div class="product card"><a href="/p/${i}"><span class="name">Item ${i}</span></a><span class="price">$ ${i}</span></div>`).join('')}</main><script>var secret = 1;</script></body></html>`;

  it('collapses repeated siblings in the outline and leaves scripts out', async () => {
    await page.setContent(grid(40));
    const outline = await outlinePage(page);
    expect(outline).toContain('main#catalog');
    expect(outline).toContain('39 more like the one above');
    expect(outline).toContain('a [href=/p/0]');
    expect(outline).not.toContain('secret');
    expect(outline.split('\n').length).toBeLessThan(20);
  });

  it('truncates an oversized outline with a marker', async () => {
    const wide = `<html><body>${Array.from({ length: 400 }, (_, i) => `<section id="s${i}" class="c${i}"><h2>Heading ${i}</h2></section>`).join('')}</body></html>`;
    await page.setContent(wide);
    const outline = await outlinePage(page, 500);
    expect(outline.length).toBeLessThan(700);
    expect(outline).toMatch(/outline truncated at 500 characters of \d+/);
  });

  it('counts matches and returns sample texts for CSS and XPath', async () => {
    await page.setContent(grid(8));
    const css = await testLocator(page, { css: '.product .name' });
    expect(css.count).toBe(8);
    expect(css.samples).toEqual([
      'Item 0',
      'Item 1',
      'Item 2',
      'Item 3',
      'Item 4',
    ]);
    const xp = await testLocator(page, { xpath: '//span[@class="price"]' });
    expect(xp.count).toBe(8);
    expect(xp.samples[0]).toBe('$ 0');
    expect(await testLocator(page, { css: '.nothing' })).toMatchObject({
      count: 0,
      samples: [],
    });
  });

  it('reports a malformed locator instead of throwing', async () => {
    await page.setContent(grid(1));
    const result = await testLocator(page, { css: '.a >>> ' });
    expect(result.count).toBe(0);
    expect(result.error).toBeDefined();
  });
});

describe('submitSpec', () => {
  it('accepts a valid spec and returns validation errors otherwise', () => {
    expect(submitSpec(validSpec()).ok).toBe(true);
    const bad = validSpec();
    delete bad.system.link;
    const result = submitSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].path).toBe('$.system.link');
  });
});
