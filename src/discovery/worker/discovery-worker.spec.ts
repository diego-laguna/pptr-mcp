import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import {
  startFixtureServer,
  FixtureServer,
} from '../../scrape/runner/fixture-server.js';
import { validSpec } from '../../scrape/spec/spec-fixtures.js';
import { SpecStore } from '../../scrape/spec/spec-store.js';
import { InMemoryObjectStore } from '../../scrape/storage/object-store.js';
import { DiscoveryMessage, FinishedAttempt } from '../api/types.js';
import { ALLOWED_TOOLS, buildAgentOptions } from './agent-options.js';
import { AgentOutcome, QueryFn, runAgent } from './agent-runner.js';
import { DiscoverySession } from './agent-session.js';
import { DiscoveryWorker } from './discovery-worker.js';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const text = (css: string) => ({ locator: { css }, source: 'text' as const });

const message = (
  siteUrl: string,
  patch: Partial<DiscoveryMessage> = {},
): DiscoveryMessage => ({
  attemptId: 'a1',
  mode: 'full',
  customerId: 'c1',
  catalogId: 'k1',
  siteId: 's1',
  siteUrl,
  snapshot: {
    schemaVersion: 1,
    properties: [
      {
        name: 'launch',
        type: 'date',
        description: 'Launch date',
        required: false,
      },
    ],
    variantProperty: null,
  },
  targetProperties: [],
  guidance: null,
  baseSpecKey: null,
  baseVersion: null,
  caps: { maxTurns: 10, maxDurationMs: 60_000, maxCostUsd: 1 },
  outputPrefix: 'discoveries/c1/s1/a1',
  ...patch,
});

/** An async iterable standing in for the model; each entry is one SDK message. */
const stub = (messages: Record<string, unknown>[], hang = false): QueryFn =>
  async function* ({ options }) {
    for (const m of messages) yield m;
    if (hang)
      await new Promise<void>((_, reject) =>
        options?.abortController?.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        ),
      );
  };

describe('agent options (3.2)', () => {
  const session = {} as DiscoverySession;
  const options = buildAgentOptions({
    message: message('https://shop.example'),
    session,
    abortController: new AbortController(),
  });

  it('allows only the browser and spec tools and no built-in tools', async () => {
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual(ALLOWED_TOOLS);
    expect(
      ALLOWED_TOOLS.map((t) => t.replace('mcp__discovery__', '')).sort(),
    ).toEqual([
      'click',
      'navigate',
      'outline_page',
      'page_text',
      'scroll',
      'submit_spec',
      'test_locator',
    ]);
    const can = options.canUseTool!;
    const meta = { signal: new AbortController().signal } as never;
    for (const denied of [
      'Bash',
      'Read',
      'Write',
      'WebFetch',
      'mcp__other__anything',
    ])
      expect(await can(denied, {}, meta)).toMatchObject({ behavior: 'deny' });
    for (const allowed of ALLOWED_TOOLS)
      expect(await can(allowed, {}, meta)).toMatchObject({ behavior: 'allow' });
  });

  it('applies the caps and ignores local settings', () => {
    expect(options).toMatchObject({
      maxTurns: 10,
      maxBudgetUsd: 1,
      settingSources: [],
    });
  });

  it('tells the agent that page content is data and what its only output is', () => {
    const prompt = options.systemPrompt as string;
    expect(prompt).toMatch(/untrusted/i);
    expect(prompt).toMatch(/never follow them/i);
    expect(prompt).toMatch(/submit_spec/);
    expect(prompt).toContain('launch (date');
  });
});

describe('caps and usage (3.3)', () => {
  const run = (
    queryFn: QueryFn,
    caps: Partial<DiscoveryMessage['caps']> = {},
  ) =>
    runAgent({
      message: message('https://shop.example', {
        caps: { maxTurns: 5, maxDurationMs: 60_000, maxCostUsd: 1, ...caps },
      }),
      session: {} as DiscoverySession,
      abortController: new AbortController(),
      queryFn,
    });

  it('records usage from the SDK result, including cost', async () => {
    const out = await run(
      stub([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'looking' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          num_turns: 4,
          duration_ms: 9000,
          total_cost_usd: 0.42,
          usage: { input_tokens: 1000, output_tokens: 200 },
          result: 'done',
        },
      ]),
    );
    expect(out.capHit).toBeNull();
    expect(out.usage).toEqual({
      turns: 4,
      durationMs: 9000,
      costUsd: 0.42,
      inputTokens: 1000,
      outputTokens: 200,
    });
  });

  it.each([
    ['error_max_turns', 'turns'],
    ['error_max_budget_usd', 'cost'],
  ])('reports %s as a %s cap and keeps usage', async (subtype, cap) => {
    const out = await run(
      stub([
        {
          type: 'result',
          subtype,
          is_error: true,
          num_turns: 5,
          duration_ms: 1000,
          total_cost_usd: 1.01,
          usage: { input_tokens: 5, output_tokens: 6 },
        },
      ]),
    );
    expect(out.capHit).toBe(cap);
    expect(out.usage.costUsd).toBe(1.01);
    expect(out.usage.turns).toBe(5);
  });

  it('stops a run that exceeds the duration cap with the watchdog', async () => {
    const started = Date.now();
    const out = await run(
      stub([{ type: 'assistant', message: { content: [] } }], true),
      { maxDurationMs: 150 },
    );
    expect(out.capHit).toBe('duration');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.usage.turns).toBe(1);
    expect(out.usage.durationMs).toBeGreaterThanOrEqual(100);
  });
});

describe.skipIf(!existsSync(chrome))(
  'discovery worker (real Chrome, scripted agent)',
  () => {
    let server: FixtureServer;
    let objects: InMemoryObjectStore;
    let sent: FinishedAttempt[];
    let profiles: string[];

    const shop = (n: number) =>
      `<html><body>${Array.from({ length: n }, (_, i) => `<div class="product"><a class="lnk" href="/p/${i}"><span class="name">Remera ${i}</span></a><img src="/i/${i}.jpg"><span class="price">$ ${i}.990,00</span><span class="date">1${i % 10}/10/2026</span></div>`).join('')}</body></html>`;

    beforeAll(async () => {
      server = await startFixtureServer({
        '/good': shop(12),
        '/blocked': '<html><body>nope</body></html>',
      });
    });
    afterAll(async () => {
      await server.close();
    });

    const url = (path: string) =>
      `http://shop.example:${server.origin.split(':').pop()}${path}`;
    const goodSpec = (path = '/good') => ({
      ...validSpec(),
      site: { url: url('') },
      steps: [{ type: 'open_url', url: url(path) }],
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
      pagination: undefined,
      properties: {
        launch: {
          ...text('.date'),
          transforms: [{ type: 'date', format: 'dd/MM/yyyy', locale: 'es-AR' }],
        },
      },
    });

    function worker(
      agent: (
        s: DiscoverySession,
        m: DiscoveryMessage,
        a: AbortController,
      ) => Promise<AgentOutcome>,
    ) {
      objects = new InMemoryObjectStore();
      sent = [];
      profiles = [];
      return new DiscoveryWorker({
        objects,
        specs: new SpecStore(objects),
        publisher: { send: async (m) => void sent.push(m) },
        launcher: {
          launch: async ({ userDataDir }) => {
            profiles.push(userDataDir);
            return puppeteer.launch({
              executablePath: chrome,
              headless: true,
              userDataDir,
              args: [
                '--no-sandbox',
                '--host-resolver-rules=MAP *.example 127.0.0.1',
              ],
            });
          },
        },
        agent,
        resolveHost: async () => ['93.184.216.34'],
        guardOptions: {
          isBlocked: () => false,
          resolveHost: async () => ['93.184.216.34'],
        },
      });
    }
    const outcome = (patch: Partial<AgentOutcome> = {}): AgentOutcome => ({
      usage: { turns: 3, durationMs: 1200, costUsd: 0.2 },
      capHit: null,
      finalText: '',
      ...patch,
    });

    it('stores the candidate, evidence and annotated screenshot under the owner prefix and reports it', async () => {
      const w = worker(async (session) => {
        await session.navigate(url('/good'));
        expect(
          await session.submit({
            spec: goodSpec(),
            unresolved: [],
            notes: 'paginated by scrolling',
          }),
        ).toMatch(/Accepted/);
        return outcome();
      });
      const result = await w.handle(message(url('/good')));

      expect(sent.map((m) => m.outcome)).toEqual(['started', 'candidate']);
      expect(result).toMatchObject({
        outcome: 'candidate',
        candidateKey: 'discoveries/c1/s1/a1/candidate.json',
        evidenceKey: 'discoveries/c1/s1/a1/evidence.json',
        usage: { turns: 3, costUsd: 0.2 },
      });
      const candidate = JSON.parse((await objects.get(result.candidateKey!))!);
      expect(candidate.properties.launch.transforms[0].type).toBe('date');
      const evidence = JSON.parse((await objects.get(result.evidenceKey!))!);
      expect(evidence).toMatchObject({
        outcome: 'candidate',
        notes: ['paginated by scrolling'],
      });
      expect(evidence.samples.length).toBeGreaterThan(0);
      expect(evidence.screenshots[0].key).toBe(
        'discoveries/c1/s1/a1/screenshots/1.png',
      );
      const png = objects.binaries.get(
        'discoveries/c1/s1/a1/screenshots/1.png',
      )!;
      expect(Buffer.from(png.body).subarray(0, 4).toString('hex')).toBe(
        '89504e47',
      );
      expect(png.contentType).toBe('image/png');
    });

    it('uses a fresh browser profile and removes it afterwards', async () => {
      const w = worker(async () =>
        outcome({ finalText: 'NO_CATALOG: nothing here' }),
      );
      await w.handle(message(url('/good')));
      await w.handle(message(url('/good')));
      expect(new Set(profiles).size).toBe(2);
      for (const dir of profiles) expect(existsSync(dir)).toBe(false);
    });

    it('maps each outcome to its failure reason and still stores the evidence', async () => {
      const cases: [
        string,
        (s: DiscoverySession) => Promise<AgentOutcome>,
        string,
      ][] = [
        [
          'no catalog',
          async () => outcome({ finalText: 'NO_CATALOG: it is a blog' }),
          'no_catalog_found',
        ],
        [
          'free text only',
          async () =>
            outcome({ finalText: 'The selectors are .product and .name' }),
          'invalid_output',
        ],
        ['cap', async () => outcome({ capHit: 'duration' }), 'cap_exceeded'],
        [
          'blocked',
          async (s) => {
            s.blockedStatuses.push(403);
            return outcome();
          },
          'blocked_by_site',
        ],
        [
          'unreachable',
          async (s) => {
            s.navigationErrors.push('net::ERR_CONNECTION_REFUSED');
            return outcome();
          },
          'unreachable_site',
        ],
        [
          'verification exhausted',
          async (s) => {
            await s.navigate(url('/good'));
            const bad = goodSpec();
            bad.system.link = {
              locator: { css: '.nothing' },
              source: { attribute: 'href' },
            };
            for (let i = 0; i < 4; i++) await s.submit({ spec: bad });
            return outcome();
          },
          'verification_failed',
        ],
      ];
      for (const [, agent, reason] of cases) {
        const w = worker(async (s, _m, _a) => agent(s));
        const result = await w.handle(message(url('/good')));
        expect(result).toMatchObject({
          outcome: 'failed',
          reason,
          usage: { turns: 3 },
        });
        expect(sent.map((m) => m.outcome)).toEqual(['started', 'failed']);
        const evidence = JSON.parse((await objects.get(result.evidenceKey!))!);
        expect(evidence.outcome).toBe('failed');
        expect(
          await objects.get('discoveries/c1/s1/a1/candidate.json'),
        ).toBeNull();
      }
    });

    it('gives the agent a fixed number of repair rounds and returns the failed checks', async () => {
      let replies: string[] = [];
      const w = worker(async (s) => {
        await s.navigate(url('/good'));
        const bad = goodSpec();
        bad.system.link = {
          locator: { css: '.nothing' },
          source: { attribute: 'href' },
        };
        for (let i = 0; i < 5; i++) replies.push(await s.submit({ spec: bad }));
        return outcome();
      });
      const result = await w.handle(message(url('/good')));
      expect(replies[0]).toMatch(/system_field_link/);
      expect(replies[0]).toMatch(/3 attempt\(s\) left/);
      expect(replies[3]).toMatch(/No repair rounds are left/);
      expect(replies[4]).toMatch(/No repair rounds are left/);
      expect(result.reason).toBe('verification_failed');
    });

    it('refuses a site URL that is not public without opening a browser', async () => {
      const w = worker(async () => outcome());
      (w as unknown as { deps: { resolveHost: unknown } }).deps.resolveHost =
        async () => ['10.0.0.5'];
      const result = await w.handle(message(url('/good')));
      expect(result).toMatchObject({
        outcome: 'failed',
        reason: 'unreachable_site',
      });
      expect(profiles).toEqual([]);
    });

    it('never touches a database', async () => {
      for (const file of [
        'discovery-worker.ts',
        'agent-session.ts',
        'agent-runner.ts',
        'agent-options.ts',
      ]) {
        const source = await readFile(
          new URL(`./${file}`, import.meta.url),
          'utf8',
        );
        expect(source).not.toMatch(/from 'pg'|database\/|\.repository/);
      }
    });
  },
);
