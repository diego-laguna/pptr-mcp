import { existsSync } from 'node:fs';
import puppeteer, { Browser } from 'puppeteer-core';
import { SelectorSpec } from '../spec/selector-spec.js';
import { validateSelectorSpec } from '../spec/spec-validator.js';
import { buildItems } from './extract.js';
import {
  FixtureServer,
  productCard,
  startFixtureServer,
} from './fixture-server.js';
import { BrowserLauncher, runSpec, runWithBrowser } from './runner.js';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const launcher: BrowserLauncher = {
  launch: () =>
    puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox'],
    }),
};

const text = (css: string) => ({ locator: { css }, source: 'text' as const });

function baseSpec(origin: string, path: string): SelectorSpec {
  return validateSelectorSpec({
    formatVersion: 1,
    site: { url: origin },
    steps: [{ type: 'open_url', url: `${origin}${path}` }],
    items: { locator: { css: '.product' } },
    system: {
      name: text('.name'),
      link: { locator: { css: 'a' }, source: { attribute: 'href' } },
      price: text('.price'),
      thumbnail_url: { locator: { css: 'img' }, source: { attribute: 'src' } },
    },
    properties: {
      launch: {
        ...text('.date'),
        transforms: [{ type: 'date', format: 'dd/MM/yyyy', locale: 'es-AR' }],
      },
    },
  });
}

const options = () => ({ deadline: Date.now() + 60_000, safetyMarginMs: 500 });

describe.skipIf(!existsSync(chrome))(
  'runner (real Chrome, fixture pages)',
  () => {
    let browser: Browser;
    let server: FixtureServer;

    const listing = (start: number, count: number, extraHead = '') =>
      `<html><body>${extraHead}${Array.from({ length: count }, (_, i) => productCard(start + i)).join('')}</body></html>`;

    beforeAll(async () => {
      browser = await launcher.launch();
      server = await startFixtureServer({
        '/single': listing(1, 3),
        '/variants': `<html><body>${[1, 2]
          .map((n) =>
            productCard(
              n,
              `<ul>${['4', '6']
                .map(
                  (s, i) =>
                    `<li><b>${s}</b><i>$ ${n}.${i}00,00</i><input ${i === 1 ? 'disabled' : ''}></li>`,
                )
                .join('')}</ul>`,
            ),
          )
          .join('')}</body></html>`,
        '/next/1': listing(1, 2, '<a class="next" href="/next/2">next</a>'),
        '/next/2': listing(3, 2, '<a class="next" href="/next/3">next</a>'),
        '/next/3': listing(5, 2, '<a class="next" href="/next/4">next</a>'),
        '/next/4': listing(7, 2),
        '/tpl': (url) => {
          const page = Number(url.searchParams.get('page') ?? 1);
          return page <= 2 ? listing(page * 10, 2) : listing(0, 0);
        },
        '/scroll': `<html><body><div id="list">${productCard(1)}${productCard(2)}</div>
        <script>
          let batches = 0;
          addEventListener('scroll', () => {
            if (batches < 2 && innerHeight + scrollY >= document.body.scrollHeight - 5) {
              batches++;
              const n = 10 * batches;
              document.getElementById('list').insertAdjacentHTML('beforeend', ${JSON.stringify(productCard(77) + productCard(78))}.replaceAll('/77', '/' + (n + 7)).replaceAll('/78', '/' + (n + 8)) + '<div style="height:1500px"></div>');
            }
          });
          document.body.insertAdjacentHTML('beforeend', '<div style="height:1500px"></div>');
        </script></body></html>`,
        '/never':
          '<html><body><script>/* never finishes */</script></body></html>',
      });
    });

    afterAll(async () => {
      await browser.close();
      await server.close();
    });

    async function run(
      spec: SelectorSpec,
      extra: Partial<ReturnType<typeof options>> & {
        limits?: { maxPages: number; maxItems: number };
      } = {},
    ) {
      const page = await browser.newPage();
      try {
        return await runSpec(page, spec, { ...options(), ...extra });
      } finally {
        await page.close();
      }
    }

    it('extracts items, raw text and typed values without variants', async () => {
      const spec = baseSpec(server.origin, '/single');
      const raw = await run(spec);
      expect(raw.finished).toBe(true);
      const { items, skipped } = buildItems(raw.rawItems, spec);
      expect(skipped).toBe(0);
      expect(items).toHaveLength(3);
      expect(items[0].raw.name).toBe('Remera 1');
      expect(items[0].raw.link).toBe(`${server.origin}/p/1`);
      expect(items[0].raw.launch).toBe('11/10/2026');
      expect(items[0].value.launch).toBe('2026-10-11');
      expect(items[0].value.price).toBe('$ 1.990,00');
      expect(items[0].variants).toBeUndefined();
    });

    it('extracts variants with value, price and availability', async () => {
      const spec = baseSpec(server.origin, '/variants');
      spec.variants = {
        locator: { css: 'li' },
        value: text('b'),
        price: text('i'),
        available: {
          locator: { css: 'input' },
          source: { attribute: 'disabled' },
          transforms: [{ type: 'boolean_map', true: [], false: [''] }],
        },
      };
      const raw = await run(spec);
      const { items } = buildItems(raw.rawItems, spec);
      expect(items[0].variants).toHaveLength(2);
      expect(items[0].variants![0].value).toMatchObject({
        value: '4',
        price: '$ 1.000,00',
      });
    });

    it('records an issue and omits the value when a transform fails', async () => {
      const spec = baseSpec(server.origin, '/single');
      spec.properties.launch.transforms = [
        { type: 'date', format: 'MM/dd/yyyy', locale: 'en-US' },
      ];
      const { items } = buildItems((await run(spec)).rawItems, spec);
      expect(items[2].value.launch).toBeUndefined();
      expect(items[2].issues[0]).toMatchObject({
        property: 'launch',
        raw: '13/10/2026',
      });
    });

    it('supports XPath locators', async () => {
      const spec = baseSpec(server.origin, '/single');
      spec.items.locator = { xpath: '//div[@class="product"]' };
      spec.system.name = {
        locator: { xpath: './/span[@class="name"]' },
        source: 'text',
      };
      const { items } = buildItems((await run(spec)).rawItems, spec);
      expect(items).toHaveLength(3);
      expect(items[1].raw.name).toBe('Remera 2');
    });

    it('follows the next button and stops at the page bound', async () => {
      const spec = baseSpec(server.origin, '/next/1');
      spec.pagination = {
        mode: 'next_button',
        locator: { css: 'a.next' },
        maxPages: 3,
      };
      const raw = await run(spec);
      expect(raw.pages).toBe(3);
      expect(raw.rawItems).toHaveLength(6);
    });

    it('stops the next button when there is no further page', async () => {
      const spec = baseSpec(server.origin, '/next/1');
      spec.pagination = {
        mode: 'next_button',
        locator: { css: 'a.next' },
        maxPages: 10,
      };
      const raw = await run(spec);
      expect(raw.pages).toBe(4);
      expect(raw.rawItems).toHaveLength(8);
    });

    it('walks a URL template until a page has no items or the bound is hit', async () => {
      const spec = baseSpec(server.origin, '/tpl?page=1');
      spec.pagination = {
        mode: 'url_template',
        template: `${server.origin}/tpl?page={page}`,
        startPage: 1,
        maxPages: 5,
      };
      const raw = await run(spec);
      expect(raw.rawItems).toHaveLength(4);
      spec.pagination.maxPages = 1;
      expect((await run(spec)).rawItems).toHaveLength(2);
    });

    it('collects more items with infinite scroll and respects the bound', async () => {
      const spec = baseSpec(server.origin, '/scroll');
      spec.pagination = { mode: 'infinite_scroll', maxScrolls: 5, maxPages: 5 };
      const raw = await run(spec);
      expect(raw.rawItems.length).toBeGreaterThan(2);
      expect(raw.pages).toBeGreaterThan(2);
      spec.pagination = { mode: 'infinite_scroll', maxScrolls: 1, maxPages: 1 };
      expect((await run(spec)).pages).toBeLessThanOrEqual(2);
    });

    it('applies preview limits to pages and items', async () => {
      const spec = baseSpec(server.origin, '/next/1');
      spec.pagination = {
        mode: 'next_button',
        locator: { css: 'a.next' },
        maxPages: 4,
      };
      const pagesLimited = await run(spec, {
        limits: { maxPages: 2, maxItems: 100 },
      });
      expect(pagesLimited.pages).toBe(2);
      const itemsLimited = await run(spec, {
        limits: { maxPages: 4, maxItems: 3 },
      });
      expect(itemsLimited.rawItems).toHaveLength(3);
    });

    it('reports an unfinished run when the deadline passes and leaves no browser process', async () => {
      const hang = await startFixtureServer({});
      // A server that accepts connections but never answers makes navigation hang.
      const { createServer } = await import('node:http');
      const slow = createServer(() => undefined);
      await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
      const port = (slow.address() as { port: number }).port;
      const spec = baseSpec(server.origin, '/single');
      spec.steps = [{ type: 'open_url', url: `http://127.0.0.1:${port}/` }];

      let pid: number | undefined;
      const tracking: BrowserLauncher = {
        launch: async () => {
          const b = await launcher.launch();
          pid = b.process()?.pid;
          return b;
        },
      };
      const started = Date.now();
      const raw = await runWithBrowser(tracking, spec, {
        deadline: Date.now() + 1500,
        safetyMarginMs: 300,
      });
      expect(raw.finished).toBe(false);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(pid).toBeDefined();
      expect(() => process.kill(pid!, 0)).toThrow(); // process is gone

      slow.closeAllConnections();
      await new Promise((r) => slow.close(r));
      await hang.close();
    });
  },
);
