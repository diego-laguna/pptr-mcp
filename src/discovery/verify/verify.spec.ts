import { existsSync } from 'node:fs';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { SelectorSpec } from '../../scrape/spec/selector-spec.js';
import { validateSelectorSpec } from '../../scrape/spec/spec-validator.js';
import {
  FixtureServer,
  startFixtureServer,
} from '../../scrape/runner/fixture-server.js';
import { runSpec } from '../../scrape/runner/runner.js';
import { buildItems } from '../../scrape/runner/extract.js';
import { captureAnnotated, overlayTargets } from './annotate.js';
import { evaluateCandidate } from './candidate-evaluator.js';
import { buildEvidence, unresolvedOf } from './evidence.js';
import { detectStability } from './stability.js';
import { verifyCandidate } from './verifier.js';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const text = (css: string) => ({ locator: { css }, source: 'text' as const });
const limits = { maxPages: 1, maxItems: 100 };
const options = () => ({ deadline: Date.now() + 60_000, limits });

interface CardOptions {
  linkEvery?: number;
  badDates?: boolean;
  colorClass?: string;
  fabricClass?: string;
}
function card(n: number, o: CardOptions = {}): string {
  const hasLink = !o.linkEvery || n % 10 < o.linkEvery;
  const date = o.badDates && n % 5 < 2 ? 'proximamente' : `1${n % 10}/10/2026`;
  return `<div class="product">
    ${hasLink ? `<a class="lnk" href="/p/${n}">` : '<a class="lnk">'}<span class="name">Remera ${n}</span></a>
    <img src="/i/${n}.jpg"><span class="price">$ ${n}.990,00</span><span class="${o.fabricClass ?? 'fabric'}">Algodon ${n}</span>
    <span class="date">${date}</span><span class="${o.colorClass ?? 'color'}">${n % 2 ? 'Rojo' : 'Azul'}</span>
  </div>`;
}
const page40 = (o: CardOptions = {}) =>
  `<html><body>${Array.from({ length: 40 }, (_, i) => card(i + 1, o)).join('')}</body></html>`;

function spec(
  origin: string,
  path: string,
  extra: Record<string, unknown> = {},
): SelectorSpec {
  return validateSelectorSpec({
    formatVersion: 1,
    site: { url: origin },
    steps: [{ type: 'open_url', url: `${origin}${path}` }],
    items: { locator: { css: '.product' } },
    system: {
      name: text('.name'),
      link: { locator: { css: 'a.lnk' }, source: { attribute: 'href' } },
      price: text('.price'),
      thumbnail_url: { locator: { css: 'img' }, source: { attribute: 'src' } },
    },
    properties: {
      launch: {
        ...text('.date'),
        transforms: [{ type: 'date', format: 'dd/MM/yyyy', locale: 'es-AR' }],
      },
    },
    ...extra,
  });
}

describe.skipIf(!existsSync(chrome))(
  'verification (real Chrome, fixture pages)',
  () => {
    let browser: Browser;
    let page: Page;
    let server: FixtureServer;

    beforeAll(async () => {
      browser = await puppeteer.launch({
        executablePath: chrome,
        headless: true,
        args: ['--no-sandbox'],
      });
      server = await startFixtureServer({
        '/good': page40(),
        '/nolinks': page40({ linkEvery: 7 }),
        '/baddates': page40({ badDates: true }),
        '/flaky': (() => {
          let hits = 0;
          return () => page40().replaceAll('$ ', `$ ${++hits}0`);
        })(),
        '/few': `<html><body>${[1, 2].map((n) => card(n)).join('')}</body></html>`,
        // redesign: the colour and fabric classes were renamed, the rest is unchanged
        '/redesign': page40({ colorClass: 'tone', fabricClass: 'mat' }),
      });
    });
    beforeEach(async () => {
      page = await browser.newPage();
    });
    afterEach(async () => {
      await page.close();
    });
    afterAll(async () => {
      await browser.close();
      await server.close();
    });

    describe('thresholds (2.2)', () => {
      it('passes a candidate that clears every threshold', async () => {
        const v = await verifyCandidate(
          page,
          spec(server.origin, '/good'),
          options(),
        );
        expect(v.passed).toBe(true);
        expect(v.items).toHaveLength(40);
        expect(v.parseRates.launch).toBe(1);
        expect(v.matchCounts.link).toBe(40);
      });

      it('fails when only 70% of items have a link', async () => {
        const v = await verifyCandidate(
          page,
          spec(server.origin, '/nolinks'),
          options(),
        );
        expect(v.passed).toBe(false);
        const failed = v.checks.filter((c) => !c.passed).map((c) => c.name);
        expect(failed).toContain('system_field_link');
      });

      it('fails when a property parses for too few of the items with raw text', async () => {
        const v = await verifyCandidate(
          page,
          spec(server.origin, '/baddates'),
          options(),
        );
        expect(v.passed).toBe(false);
        expect(v.parseRates.launch).toBeCloseTo(0.6, 1);
        expect(
          v.checks.find((c) => c.name === 'parse_rate_launch')!.passed,
        ).toBe(false);
      });

      it('fails below the minimum item count', async () => {
        const v = await verifyCandidate(
          page,
          spec(server.origin, '/few'),
          options(),
        );
        expect(v.checks.find((c) => c.name === 'item_count')!.passed).toBe(
          false,
        );
      });
    });

    describe('incremental checks (2.3)', () => {
      const withColor = (path: string, locator = '.color') => {
        const s = spec(server.origin, path);
        s.properties.color = text(locator);
        return s;
      };

      it('accepts base plus a new binding with identical existing values', async () => {
        const base = spec(server.origin, '/good');
        const result = await evaluateCandidate(page, {
          mode: 'incremental',
          candidate: withColor('/good'),
          base,
          targets: ['color'],
          variantProperty: null,
          options: options(),
        });
        expect(result.kind).toBe('ok');
      });

      it('rejects a candidate that modifies an existing binding as invalid_output', async () => {
        const base = spec(server.origin, '/good');
        const candidate = withColor('/good');
        candidate.properties.launch = text('.name');
        const result = await evaluateCandidate(page, {
          mode: 'incremental',
          candidate,
          base,
          targets: ['color'],
          variantProperty: null,
          options: options(),
        });
        expect(result).toMatchObject({ kind: 'invalid_output' });
        if (result.kind === 'invalid_output')
          expect(result.problems.join()).toMatch(/"launch"/);
      });

      it('rejects a candidate that changes a system field or the steps', async () => {
        const base = spec(server.origin, '/good');
        const candidate = withColor('/good');
        candidate.system.price = text('.name');
        const result = await evaluateCandidate(page, {
          mode: 'incremental',
          candidate,
          base,
          targets: ['color'],
          variantProperty: null,
          options: options(),
        });
        expect(result).toMatchObject({ kind: 'invalid_output' });
      });

      it('fails verification when existing values differ from the base on the same pages', async () => {
        // /flaky serves a different price on every request, so the same bindings read different
        // values for the same links between the base run and the candidate run.
        const base = spec(server.origin, '/flaky');
        const candidate = withColor('/flaky');
        const result = await evaluateCandidate(page, {
          mode: 'incremental',
          candidate,
          base,
          targets: ['color'],
          variantProperty: null,
          options: options(),
        });
        expect(result.kind).toBe('verification_failed');
        if (result.kind === 'verification_failed')
          expect(result.details).toMatch(
            /no_regression: existing values changed: price/,
          );
      });

      it('reports regressions found by comparing typed values by link', async () => {
        const { checkRegression } = await import('./diff-checks.js');
        const item = (link: string, price: string) => ({
          raw: { link },
          value: { link, price },
          issues: [],
        });
        expect(
          checkRegression(
            [item('a', '$ 1'), item('b', '$ 2')],
            [item('a', '$ 1'), item('b', '$ 3')],
            ['price'],
          ),
        ).toEqual([
          { property: 'price', link: 'b', before: '$ 2', after: '$ 3' },
        ]);
        expect(
          checkRegression([item('a', '$ 1')], [item('z', '$ 9')], ['price']),
        ).toEqual([]);
      });
    });

    describe('repair checks (2.3b)', () => {
      // The base was written against the old markup; the site now serves /redesign.
      const brokenBase = () => {
        const s = spec(server.origin, '/redesign');
        s.properties.color = text('.color');
        s.properties.fabric = text('.fabric');
        return s;
      };
      const repaired = (
        colorLoc: string | null = '.tone',
        fabricLoc: string | null = '.mat',
      ) => {
        const s = brokenBase();
        delete s.properties.color;
        delete s.properties.fabric;
        if (colorLoc) s.properties.color = text(colorLoc);
        if (fabricLoc) s.properties.fabric = text(fabricLoc);
        return s;
      };
      const run = (candidate: SelectorSpec, targets = ['color', 'fabric']) =>
        evaluateCandidate(page, {
          mode: 'repair',
          candidate,
          base: brokenBase(),
          targets,
          variantProperty: null,
          options: options(),
        });

      it('replaces only the targeted bindings and shows before and after', async () => {
        const result = await run(repaired());
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
          expect(result.comparisons).toEqual([
            {
              property: 'color',
              oldMatches: 0,
              oldParseRate: null,
              newMatches: 40,
              newParseRate: 1,
            },
            {
              property: 'fabric',
              oldMatches: 0,
              oldParseRate: null,
              newMatches: 40,
              newParseRate: 1,
            },
          ]);
        }
      });

      it('rejects a change to a system field, a step or an untargeted binding as invalid_output', async () => {
        for (const mutate of [
          (s: SelectorSpec) => {
            s.system.name = text('.color');
          },
          (s: SelectorSpec) => {
            s.steps = [{ type: 'open_url', url: `${server.origin}/good` }];
          },
          (s: SelectorSpec) => {
            s.properties.launch = text('.name');
          },
        ]) {
          const candidate = repaired();
          mutate(candidate);
          expect((await run(candidate)).kind).toBe('invalid_output');
        }
      });

      it('offers a partly unresolved repair and lists the omitted property', async () => {
        const candidate = repaired('.tone', null);
        const result = await run(candidate);
        expect(result.kind).toBe('ok');
        const unresolved = unresolvedOf(candidate, ['color', 'fabric'], null, [
          {
            property: 'fabric',
            reason: 'the fabric no longer appears in the card',
          },
        ]);
        expect(unresolved).toEqual([
          {
            property: 'fabric',
            reason: 'the fabric no longer appears in the card',
          },
        ]);
      });

      it('fails verification when nothing was repaired', async () => {
        const result = await run(repaired(null, null));
        expect(result.kind).toBe('verification_failed');
        if (result.kind === 'verification_failed')
          expect(result.details).toMatch(/repaired_any/);
      });

      it('fails verification when a repaired binding does not parse', async () => {
        const candidate = repaired();
        candidate.properties.color = {
          ...text('.name'),
          transforms: [{ type: 'number', locale: 'es-AR' }],
        };
        const result = await run(candidate);
        expect(result.kind).toBe('verification_failed');
        if (result.kind === 'verification_failed')
          expect(result.details).toMatch(/parse_rate_color/);
      });
    });

    describe('evidence and stability (2.4)', () => {
      it('flags positional, long absolute and hash-like locators without failing', () => {
        const s = spec(server.origin, '/good');
        s.system.name = text('div:nth-child(3) > span:nth-child(2)');
        s.properties.launch = {
          locator: { xpath: '/html/body/div[2]/div/div/ul/li/span/b' },
          source: 'text',
        };
        s.system.price = text('.css-1x9ab3q');
        const warnings = detectStability(s);
        expect(warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ binding: 'name', reason: 'positional' }),
            expect.objectContaining({
              binding: 'launch',
              reason: 'long_absolute_path',
            }),
            expect.objectContaining({
              binding: 'launch',
              reason: 'positional',
            }),
            expect.objectContaining({
              binding: 'price',
              reason: 'generated_class_name',
            }),
          ]),
        );
        expect(detectStability(spec(server.origin, '/good'))).toEqual([]);
      });

      it('assembles evidence with up to 20 samples, rates, warnings and unresolved properties', async () => {
        const s = spec(server.origin, '/good');
        const v = await verifyCandidate(page, s, options());
        const evidence = buildEvidence({
          outcome: 'candidate',
          mode: 'full',
          targets: [],
          spec: s,
          verification: v,
          unresolved: unresolvedOf(s, ['launch', 'fabric'], null, []),
          guardEvents: [
            { kind: 'blocked_address', url: 'http://169.254.169.254/' },
          ],
          notes: ['listing is paginated by URL'],
        });
        expect(evidence.samples).toHaveLength(20);
        expect(evidence.samples[0].raw.launch).toBe('11/10/2026');
        expect(evidence.samples[0].value.launch).toBe('2026-10-11');
        expect(evidence.parseRates.launch).toBe(1);
        expect(evidence.unresolved).toEqual([
          {
            property: 'fabric',
            reason: 'no element was located with confidence',
          },
        ]);
        expect(evidence.guardEvents).toHaveLength(1);
        expect(evidence.notes).toEqual(['listing is paginated by URL']);
      });
    });

    describe('annotated screenshots (2.5)', () => {
      it('outlines and labels bound elements, reports unmatched bindings, and leaves extraction unchanged', async () => {
        const s = spec(server.origin, '/good');
        s.properties.ghost = text('.does-not-exist');

        await page.goto(`${server.origin}/good`);
        const before = buildItems(
          (
            await runSpec(page, s, {
              deadline: Date.now() + 30000,
              safetyMarginMs: 0,
            })
          ).rawItems,
          s,
        ).items;

        const shot = await captureAnnotated(page, s);
        expect(shot.png.byteLength).toBeGreaterThan(1000);
        expect(Buffer.from(shot.png).subarray(0, 4).toString('hex')).toBe(
          '89504e47',
        ); // PNG
        expect(shot.notHighlighted).toEqual(['ghost']);
        expect(overlayTargets(s).map((t) => t.name)).toEqual(
          expect.arrayContaining([
            'item',
            'name',
            'link',
            'price',
            'thumbnail_url',
            'launch',
            'ghost',
          ]),
        );

        // Labels were drawn while the overlay was present, and removed afterwards.
        await page.goto(`${server.origin}/good`);
        await captureAnnotated(page, s);
        expect(await page.$('[data-discovery-overlay]')).toBeNull();

        await page.goto('about:blank');
        const after = buildItems(
          (
            await runSpec(page, s, {
              deadline: Date.now() + 30000,
              safetyMarginMs: 0,
            })
          ).rawItems,
          s,
        ).items;
        expect(after).toEqual(before);
      });

      it('draws a label for every bound property while the overlay is up', async () => {
        const s = spec(server.origin, '/good');
        await page.goto(`${server.origin}/good`);
        const { injectOverlay } = await import('./annotate.js');
        const unmatched = await page.evaluate(
          injectOverlay,
          overlayTargets(s),
          3,
        );
        expect(unmatched).toEqual([]);
        const labels = await page.$$eval(
          '[data-discovery-overlay] span',
          (els) => [...new Set(els.map((e) => e.textContent))],
        );
        expect(labels.sort()).toEqual(
          ['item', 'launch', 'link', 'name', 'price', 'thumbnail_url'].sort(),
        );
      });
    });
  },
);
