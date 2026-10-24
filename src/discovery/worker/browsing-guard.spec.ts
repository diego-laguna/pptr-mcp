import { existsSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { createServer, Server } from 'node:http';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { inScope, installBrowsingGuard, siteScope } from './browsing-guard.js';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

function listen(
  host: string,
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, host, () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

describe('scope helpers', () => {
  it('treats www and subdomains as the site', () => {
    const scope = siteScope('https://www.shop.example/kids');
    expect(scope).toBe('shop.example');
    expect(inScope('shop.example', scope)).toBe(true);
    expect(inScope('www.shop.example', scope)).toBe(true);
    expect(inScope('cdn.shop.example', scope)).toBe(true);
    expect(inScope('evilshop.example', scope)).toBe(false);
    expect(inScope('shop.example.evil.test', scope)).toBe(false);
  });
});

// The test site lives on 127.0.0.1, "internal" is 127.0.0.2 and "another domain" is localhost.
describe.skipIf(!existsSync(chrome))(
  'browsing guard (real Chrome, local servers)',
  () => {
    let browser: Browser;
    let page: Page;
    let site: { server: Server; port: number };
    let internal: { server: Server; port: number };
    let other: { server: Server; port: number };
    let internalHits = 0;
    let otherHits = 0;

    beforeAll(async () => {
      browser = await puppeteer.launch({
        executablePath: chrome,
        headless: true,
        args: ['--no-sandbox'],
      });
      internal = await listen('127.0.0.2', (_req, res) => {
        internalHits++;
        res.end('secret');
      });
      other = await listen('127.0.0.1', (_req, res) => {
        otherHits++;
        res.setHeader('content-type', 'image/svg+xml');
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        );
      });
      site = await listen('127.0.0.1', (req, res) => {
        res.setHeader('content-type', 'text/html');
        if (req.url === '/redirect-internal') {
          res.writeHead(302, {
            location: `http://127.0.0.2:${internal.port}/`,
          });
          return res.end();
        }
        if (req.url === '/download') {
          res.setHeader('content-disposition', 'attachment; filename=x.bin');
          res.setHeader('content-type', 'application/octet-stream');
          return res.end('bin');
        }
        res.end(`<html><body><h1>shop</h1><img src="http://localhost:${other.port}/logo.svg">
        <img src="http://127.0.0.2:${internal.port}/pixel.png"></body></html>`);
      });
    });
    beforeEach(async () => {
      page = await browser.newPage();
      internalHits = 0;
      otherHits = 0;
    });
    afterEach(async () => {
      await page.close();
    });
    afterAll(async () => {
      await browser.close();
      for (const s of [site, internal, other]) {
        s.server.closeAllConnections();
        s.server.close();
      }
    });

    const guard = () =>
      installBrowsingGuard(page, {
        siteUrl: `http://127.0.0.1:${site.port}/`,
        isBlocked: (address) => address === '127.0.0.2',
      });

    it('blocks a redirect to an internal address and records a guard event', async () => {
      const g = await guard();
      await page
        .goto(`http://127.0.0.1:${site.port}/redirect-internal`)
        .catch(() => undefined);
      expect(internalHits).toBe(0);
      expect(g.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'blocked_address',
            url: expect.stringContaining('127.0.0.2'),
          }),
        ]),
      );
    });

    it('blocks top-level navigation to an unrelated domain', async () => {
      const g = await guard();
      await page.goto(`http://127.0.0.1:${site.port}/`, {
        waitUntil: 'networkidle0',
      });
      otherHits = 0; // the page's own "CDN" image already counted once
      await page.goto(`http://localhost:${other.port}/`).catch(() => undefined);
      expect(otherHits).toBe(0);
      expect(g.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'blocked_domain' }),
        ]),
      );
    });

    it('allows subresources from another public domain but not from an internal address', async () => {
      const g = await guard();
      await page.goto(`http://127.0.0.1:${site.port}/`, {
        waitUntil: 'networkidle0',
      });
      expect(otherHits).toBe(1); // the "CDN" image loaded
      expect(internalHits).toBe(0); // the internal image did not
      expect(g.events.filter((e) => e.kind === 'blocked_address')).toHaveLength(
        1,
      );
    });

    it('blocks non-http schemes', async () => {
      const g = await guard();
      await page.goto(`http://127.0.0.1:${site.port}/`);
      await page.goto('file:///etc/passwd').catch(() => undefined);
      await page.goto(`http://127.0.0.1:${site.port}/`);
      await page.evaluate(() =>
        fetch('ftp://example.com/x').catch(() => 'blocked'),
      );
      expect(g.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'blocked_scheme' }),
        ]),
      );
    });

    it('refuses a download', async () => {
      await guard();
      await page.goto(`http://127.0.0.1:${site.port}/`);
      const result = await page.evaluate(
        (u) => fetch(u).then((r) => r.status),
        `http://127.0.0.1:${site.port}/download`,
      );
      expect(result).toBe(200); // fetch is not a download; a navigation to it would be
      await page
        .goto(`http://127.0.0.1:${site.port}/download`)
        .catch(() => undefined);
      expect(
        await page.evaluate(() => document.body?.innerText ?? ''),
      ).not.toContain('bin');
    });
  },
);
