import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { DiscoveryFinalizer } from '../../src/discovery/api/discovery-finalizer.js';
import { AgentOutcome } from '../../src/discovery/worker/agent-runner.js';
import { DiscoverySession } from '../../src/discovery/worker/agent-session.js';
import { DiscoveryWorker } from '../../src/discovery/worker/discovery-worker.js';
import { RunFinalizer } from '../../src/scrape/api/run-finalizer.js';
import {
  FixtureServer,
  startFixtureServer,
} from '../../src/scrape/runner/fixture-server.js';
import { runWithBrowser } from '../../src/scrape/runner/runner.js';
import { ScrapeWorker } from '../../src/scrape/worker/worker.js';
import { getActive } from '../support/active.js';
import { createTestDatabase, TestDatabase } from '../support/test-database.js';
import { buildActivationApp, createSiteWith, headers } from './support.js';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const text = (css: string) => ({ locator: { css }, source: 'text' as const });
const launchChrome = (userDataDir?: string) =>
  puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir,
    args: ['--no-sandbox', '--host-resolver-rules=MAP *.example 127.0.0.1'],
  });

describe.skipIf(!existsSync(chrome))(
  'activation end to end (real Chrome and Postgres, scripted agent, in-memory AWS)',
  () => {
    let db: TestDatabase;
    let h: Awaited<ReturnType<typeof buildActivationApp>>;
    let fixtures: FixtureServer;
    let port: string;
    let discoveryWorker: DiscoveryWorker;
    let scrapeWorker: ScrapeWorker;
    let discoveryFinalizer: DiscoveryFinalizer;
    let agent: (s: DiscoverySession) => Promise<AgentOutcome>;
    const reconciled: { siteId: string; runId: string; items: number }[] = [];

    const card = (
      n: number,
    ) => `<div class="product"><a class="lnk" href="/p/${n}"><span class="name">Remera ${n}</span></a><img src="/i/${n}.jpg">
    <span class="price">$ ${n}.990,00</span><span class="gender">${n % 2 ? 'Nena' : 'Nene'}</span><span class="type">Remera</span><span class="fabric">Algodon</span></div>`;

    beforeAll(async () => {
      db = await createTestDatabase();
      h = await buildActivationApp(db);
      fixtures = await startFixtureServer({
        '/shop': `<html><body>${Array.from({ length: 12 }, (_, i) => card(i + 1)).join('')}</body></html>`,
      });
      port = fixtures.origin.split(':').pop()!;

      const scrapeFinalizer = new RunFinalizer({
        runs: h.runs,
        results: h.objects,
        reconciler: {
          reconcile: async (i) =>
            void reconciled.push({
              siteId: i.siteId,
              runId: i.runId,
              items: i.items.length,
            }),
        },
        failures: { publish: async () => undefined },
      });
      scrapeWorker = new ScrapeWorker({
        specs: h.specs,
        results: h.objects,
        publisher: { send: (m) => scrapeFinalizer.handle(m) },
        execute: (spec, opts) =>
          runWithBrowser({ launch: () => launchChrome() }, spec, opts),
        safetyMarginMs: 100,
      });
      discoveryFinalizer = new DiscoveryFinalizer({
        pool: db.pool,
        attempts: h.attempts,
        specs: h.specs,
        objects: h.objects,
        // the same hook the application installs: every stored version gets a preview
        onVersionStored: ({ siteId, version }) =>
          h.scrapes
            .request({ mode: 'preview', siteId, specVersion: version })
            .then(() => undefined),
      });
      discoveryWorker = new DiscoveryWorker({
        objects: h.objects,
        specs: h.specs,
        publisher: { send: (m) => discoveryFinalizer.handle(m) },
        launcher: { launch: ({ userDataDir }) => launchChrome(userDataDir) },
        agent: async (s) => agent(s),
        resolveHost: async () => ['93.184.216.34'],
        guardOptions: {
          isBlocked: () => false,
          resolveHost: async () => ['93.184.216.34'],
        },
      });
    });
    afterAll(async () => {
      await h.app.close();
      await fixtures.close();
      await db.close();
    });

    const url = (path: string) => `http://shop.example:${port}${path}`;
    const http = () => request(h.app.getHttpServer() as App);
    const outcome: AgentOutcome = {
      usage: { turns: 4, durationMs: 500, costUsd: 0.1 },
      capHit: null,
      finalText: '',
    };
    const spec = (properties: Record<string, unknown>) => ({
      formatVersion: 1,
      site: { url: url('') },
      steps: [{ type: 'open_url', url: url('/shop') }],
      items: { locator: { css: '.product' } },
      system: {
        name: text('.name'),
        link: { locator: { css: 'a.lnk' }, source: { attribute: 'href' } },
        price: text('.price'),
        thumbnail_url: {
          locator: { css: 'img' },
          source: { attribute: 'src' },
        },
      },
      properties,
    });
    const genderBinding = {
      ...text('.gender'),
      transforms: [{ type: 'enum_map', map: { nena: 'girls', nene: 'boys' } }],
    };

    /** Delivers everything waiting on the scrape queue through the worker, like the Lambda event source. */
    async function drainScrapes() {
      for (;;) {
        const r = await h.scrapeQueue.deliverNext((m) =>
          scrapeWorker
            .handle(m, { remainingMs: () => 60_000 })
            .then(() => undefined),
        );
        if (r === 'empty') return;
      }
    }

    async function newSite(name: string) {
      const ctx = await createSiteWith(db, name, [
        {
          name: 'fabric',
          type: 'string',
          description: 'Fabric',
          required: true,
        },
        { name: 'season', type: 'string', description: 'Season' },
      ]);
      await db.pool.query('UPDATE sites SET url = $2 WHERE id = $1', [
        ctx.site.id,
        url('/shop'),
      ]);
      return ctx;
    }

    /** Discovery runs, stores a version, and its automatic preview is delivered. */
    async function discoverVersion(
      siteId: string,
      properties: Record<string, unknown>,
    ) {
      agent = async (s) => {
        await s.navigate(url('/shop'));
        expect(await s.submit({ spec: spec(properties) })).toMatch(/Accepted/);
        return outcome;
      };
      const { attemptId } = await h.discoveries.request({
        siteId,
        mode: 'full',
      });
      await discoveryWorker.handle(
        h.discoveryQueue.sent.find((m) => m.attemptId === attemptId)!,
      );
      await drainScrapes();
      return attemptId;
    }

    it('5.2: discover, preview automatically, activate with an acknowledged gap, and see the first production run', async () => {
      const { customer, site } = await newSite('FlowA');
      for (const [property, reason] of [
        ['gender', 'property_pending'],
        ['fabric', 'property_pending'],
        ['season', 'property_pending'],
      ] as const)
        await db.pool.query(
          'INSERT INTO site_attention (site_id, reason, property) VALUES ($1, $2, $3)',
          [site.id, reason, property],
        );

      await discoverVersion(site.id, {
        gender: genderBinding,
        type: text('.type'),
      });

      // the preview ran without anyone asking for it
      const review = await http()
        .get(`/internal/sites/${site.id}/spec-versions/1/review`)
        .set(headers(customer.id))
        .expect(200);
      expect(review.body).toMatchObject({
        preview: { status: 'succeeded', expired: false },
        readyToActivate: true,
        activeVersion: null,
      });
      expect(review.body.preview.sample[0]).toMatchObject({
        raw: { gender: 'Nena' },
        value: { gender: 'girls' },
      });
      expect(review.body.evidence.screenshots).toHaveLength(1);
      expect(review.body.unboundProperties).toEqual([
        { name: 'fabric', required: true },
        { name: 'season', required: false },
      ]);

      // required fabric is unbound: activation needs the acknowledgment, and nothing changes without it
      const body = {
        version: 1,
        expectedCurrent: null,
        cadence: { expression: 'rate(1 day)' },
      };
      await http()
        .post(`/internal/sites/${site.id}/activations`)
        .set(headers(customer.id))
        .send(body)
        .expect(422);
      expect(await getActive(db.pool, site.id)).toBeNull();

      await http()
        .post(`/internal/sites/${site.id}/activations`)
        .set(headers(customer.id))
        .send({ ...body, acknowledge: ['fabric'] })
        .expect(200);
      expect(await getActive(db.pool, site.id)).toBe(1);

      const markers = (
        await db.pool.query(
          'SELECT property, cleared_at IS NOT NULL AS cleared FROM site_attention WHERE site_id = $1 ORDER BY property',
          [site.id],
        )
      ).rows;
      expect(markers).toEqual([
        { property: 'fabric', cleared: false },
        { property: 'gender', cleared: true },
        { property: 'season', cleared: false },
      ]);
      expect(h.schedules.schedules.get(site.id)).toEqual({
        expression: 'rate(1 day)',
        timezone: 'UTC',
      });

      reconciled.length = 0;
      await drainScrapes();
      const production = (
        await db.pool.query(
          "SELECT id, status, spec_version, item_count FROM scrape_runs WHERE site_id = $1 AND mode = 'production'",
          [site.id],
        )
      ).rows;
      expect(production).toEqual([
        expect.objectContaining({
          status: 'succeeded',
          spec_version: 1,
          item_count: 12,
        }),
      ]);
      expect(reconciled).toEqual([
        { siteId: site.id, runId: production[0].id, items: 12 },
      ]);

      const history = await http()
        .get(`/internal/sites/${site.id}/activations`)
        .set(headers(customer.id))
        .expect(200);
      expect(history.body.activations).toHaveLength(1);
      expect(history.body.activations[0]).toMatchObject({
        version: 1,
        replacedVersion: null,
        acknowledgedProperties: ['fabric'],
      });
      expect(history.body.activations[0].previewRunId).toEqual(
        expect.any(String),
      );
    });

    it('5.3: activates 3 over 2 and rolls back to 2; each step runs the expected version and history lists all newest first', async () => {
      const { customer, site } = await newSite('FlowB');
      const bindings = [
        { gender: genderBinding, type: text('.type'), fabric: text('.fabric') },
        {
          gender: genderBinding,
          type: text('.type'),
          fabric: text('.fabric'),
          season: text('.type'),
        },
        {
          gender: genderBinding,
          fabric: text('.fabric'),
          season: text('.type'),
        },
      ];
      for (const properties of bindings)
        await discoverVersion(site.id, properties);

      const activate = (
        version: number,
        expectedCurrent: number | null,
        extra: object = {},
      ) =>
        http()
          .post(`/internal/sites/${site.id}/activations`)
          .set(headers(customer.id))
          .send({ version, expectedCurrent, ...extra });
      const refresh = async () => {
        const { runId } = await h.scrapes.request({
          mode: 'production',
          siteId: site.id,
        });
        await drainScrapes();
        return (await h.runs.get(customer.id, runId)).specVersion;
      };

      await activate(2, null, {
        cadence: { expression: 'rate(1 day)' },
      }).expect(200);
      await drainScrapes(); // the first scrape started by the activation
      expect(await refresh()).toBe(2);

      await activate(3, 2).expect(200);
      expect(await refresh()).toBe(3);

      await activate(2, 3).expect(200); // rollback: version 2 was live before, so no new preview is needed
      expect(await refresh()).toBe(2);
      expect(await getActive(db.pool, site.id)).toBe(2);

      const history = await http()
        .get(`/internal/sites/${site.id}/activations`)
        .set(headers(customer.id))
        .expect(200);
      expect(
        history.body.activations.map(
          (a: { version: number; replacedVersion: number | null }) => [
            a.version,
            a.replacedVersion,
          ],
        ),
      ).toEqual([
        [2, 3],
        [3, 2],
        [2, null],
      ]);
      // version 3 stays stored and reviewable after the rollback
      const list = await http()
        .get(`/internal/sites/${site.id}/spec-versions`)
        .set(headers(customer.id))
        .expect(200);
      expect(
        list.body.versions.map((v: { version: number }) => v.version),
      ).toEqual([3, 2, 1]);
      expect(list.body.activeVersion).toBe(2);
    });
  },
);
