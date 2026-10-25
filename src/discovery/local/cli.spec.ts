import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import {
  FixtureServer,
  startFixtureServer,
} from '../../scrape/runner/fixture-server.js';
import { validSpec } from '../../scrape/spec/spec-fixtures.js';
import { AgentOutcome } from '../worker/agent-runner.js';
import { DiscoverySession } from '../worker/agent-session.js';
import { DiscoveryMessage } from '../api/types.js';
import { runCli } from './cli.js';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const text = (css: string) => ({ locator: { css }, source: 'text' as const });
const prop = (name: string, type = 'string') => ({
  name,
  type,
  description: name,
  required: false,
  filterable: false,
});

const launcher = {
  launch: ({ userDataDir }: { userDataDir: string }) =>
    puppeteer.launch({
      executablePath: chrome,
      headless: true,
      userDataDir,
      args: ['--no-sandbox'],
    }),
};

const outcome = (patch: Partial<AgentOutcome> = {}): AgentOutcome => ({
  usage: { turns: 3, durationMs: 900, costUsd: 0.2 },
  capHit: null,
  finalText: '',
  ...patch,
});

describe.skipIf(!existsSync(chrome))(
  'local discovery CLI (real Chrome, scripted agent)',
  () => {
    let server: FixtureServer;
    let dir: string;
    let schemaFile: string;
    let baseFile: string;
    let port: string;
    const shop = `<html><body>${Array.from({ length: 12 }, (_, i) => `<div class="product"><a class="lnk" href="/p/${i}"><span class="name">Remera ${i}</span></a><img src="/i/${i}.jpg"><span class="price">$ ${i}.990,00</span><span class="date">1${i % 10}/10/2026</span></div>`).join('')}</body></html>`;

    beforeAll(async () => {
      server = await startFixtureServer({ '/good': shop, '/other': shop });
      port = server.origin.split(':').pop()!;
      dir = await mkdtemp(join(tmpdir(), 'local-cli-'));
      schemaFile = join(dir, 'schema.json');
      await writeFile(
        schemaFile,
        JSON.stringify({
          properties: [prop('launch', 'date'), prop('fabric')],
        }),
      );
      baseFile = join(dir, 'base.json');
      await writeFile(baseFile, JSON.stringify(validSpec())); // binds `launch`
    });
    afterAll(async () => {
      await server.close();
    });

    const goodUrl = () => `http://127.0.0.1:${port}/good`;
    const goodSpec = () => ({
      ...validSpec(),
      site: { url: `http://127.0.0.1:${port}` },
      steps: [{ type: 'open_url', url: goodUrl() }],
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

    const acceptingAgent = async (
      session: DiscoverySession,
    ): Promise<AgentOutcome> => {
      await session.navigate(goodUrl());
      await session.submit({ spec: goodSpec(), unresolved: [], notes: '' });
      return outcome();
    };

    async function run(
      args: string[],
      agent: (
        s: DiscoverySession,
        m: DiscoveryMessage,
        a: AbortController,
      ) => Promise<AgentOutcome>,
      env: NodeJS.ProcessEnv = {},
    ) {
      const lines: string[] = [];
      const code = await runCli(
        [...args, '--schema', schemaFile, '--out', join(dir, 'runs')],
        { agent, launcher, env, out: (l) => lines.push(l) },
      );
      return { code, lines, text: lines.join('\n') };
    }
    const runs = async () => (await readdir(join(dir, 'runs'))).sort();

    it('writes candidate, evidence, screenshot and result, and reports usage; a second run gets a new directory', async () => {
      const first = await run([goodUrl(), '--allow-private'], acceptingAgent);
      expect(first.code).toBe(0);
      expect(first.text).toMatch(/outcome: candidate/);
      expect(first.text).toMatch(/usage: 3 turns, 0\.9 s, cost \$0\.20/);
      expect(first.text).toMatch(
        /caps: 15 turns, 5 min, \$1 \(local defaults\)/,
      );
      expect(first.text).toMatch(/private addresses were allowed/);

      const [dirName] = await runs();
      const files = await readdir(join(dir, 'runs', dirName));
      expect(files).toEqual(
        expect.arrayContaining([
          'candidate.json',
          'evidence.json',
          'result.json',
          'screenshots',
        ]),
      );
      expect(
        JSON.parse(
          await readFile(join(dir, 'runs', dirName, 'candidate.json'), 'utf8'),
        ).properties.launch,
      ).toBeDefined();

      const before = await readFile(
        join(dir, 'runs', dirName, 'candidate.json'),
        'utf8',
      );
      const second = await run([goodUrl(), '--allow-private'], acceptingAgent);
      expect(second.code).toBe(0);
      const all = await runs();
      expect(all).toHaveLength(2);
      expect(
        await readFile(join(dir, 'runs', dirName, 'candidate.json'), 'utf8'),
      ).toBe(before);
    });

    it('refuses a loopback site by default without running the agent', async () => {
      let called = false;
      const result = await run([goodUrl()], async () => {
        called = true;
        return outcome();
      });
      expect(called).toBe(false);
      expect(result.code).toBe(1);
      expect(result.text).toMatch(/outcome: failed \(unreachable_site\)/);
      expect(result.text).not.toMatch(/private addresses were allowed/);
    });

    it('still confines navigation to the site with the flag on', async () => {
      const result = await run(
        [goodUrl(), '--allow-private'],
        async (session) => {
          await session.navigate(`http://localhost:${port}/other`);
          return acceptingAgent(session);
        },
      );
      expect(result.code).toBe(0);
      const evidencePath = result.lines
        .find((l) => l.startsWith('output: '))!
        .slice(8);
      const evidence = JSON.parse(
        await readFile(join(evidencePath, 'evidence.json'), 'utf8'),
      );
      expect(evidence.guardEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'blocked_domain' }),
        ]),
      );
    });

    it('keeps the cloud metadata address blocked even with the flag', async () => {
      let called = false;
      const result = await run(
        ['http://169.254.169.254/latest', '--allow-private'],
        async () => {
          called = true;
          return outcome();
        },
      );
      expect(called).toBe(false);
      expect(result.text).toMatch(/unreachable_site/);
    });

    it('reports a cap hit with the usage so far and a non-zero exit', async () => {
      const result = await run(
        [goodUrl(), '--allow-private', '--max-cost', '0.5'],
        async () =>
          outcome({
            capHit: 'cost',
            usage: { turns: 9, durationMs: 4000, costUsd: 0.51 },
          }),
      );
      expect(result.code).toBe(1);
      expect(result.text).toMatch(/failed \(cap_exceeded\)/);
      expect(result.text).toMatch(/usage: 9 turns, 4\.0 s, cost \$0\.51/);
      expect(result.text).toMatch(/caps: 15 turns, 5 min, \$0\.5$/m);
    });

    it('stores the base spec and passes the targets to an incremental run', async () => {
      let seen: DiscoveryMessage | undefined;
      const result = await run(
        [
          goodUrl(),
          '--allow-private',
          '--mode',
          'incremental',
          '--base',
          baseFile,
        ],
        async (_s, m) => {
          seen = m;
          return outcome({ finalText: 'NO_CATALOG: n/a' });
        },
      );
      expect(result.code).toBe(1);
      expect(seen).toMatchObject({
        mode: 'incremental',
        targetProperties: ['fabric'],
        baseVersion: 1,
      });
      const base = JSON.parse(
        await readFile(join(dir, 'runs', seen!.attemptId, 'base.json'), 'utf8'),
      );
      expect(base.formatVersion).toBe(1);
    });

    it('passes the repair targets with the base', async () => {
      let seen: DiscoveryMessage | undefined;
      await run(
        [
          goodUrl(),
          '--allow-private',
          '--mode',
          'repair',
          '--base',
          baseFile,
          '--properties',
          'launch',
        ],
        async (_s, m) => {
          seen = m;
          return outcome({ finalText: 'NO_CATALOG: n/a' });
        },
      );
      expect(seen).toMatchObject({
        mode: 'repair',
        targetProperties: ['launch'],
      });
    });

    it('fails before any agent call or browser launch on bad input', async () => {
      let called = false;
      const agent = async () => {
        called = true;
        return outcome();
      };
      const before = (await runs()).length;
      for (const args of [
        [goodUrl(), '--mode', 'incremental'],
        [goodUrl(), '--mode', 'repair', '--base', baseFile],
        [
          goodUrl(),
          '--mode',
          'incremental',
          '--base',
          baseFile,
          '--properties',
          'colour',
        ],
      ]) {
        const r = await run(args, agent);
        expect(r.code).toBe(2);
        expect(r.text).toMatch(/error:/);
      }
      expect(called).toBe(false);
      expect(await runs()).toHaveLength(before);
    });

    it('stops on missing credentials before launching anything', async () => {
      const lines: string[] = [];
      const code = await runCli(
        [goodUrl(), '--schema', schemaFile, '--out', join(dir, 'runs')],
        { env: {}, launcher, out: (l) => lines.push(l) },
      );
      expect(code).toBe(2);
      expect(lines.join('\n')).toMatch(/ANTHROPIC_API_KEY/);
    });
  },
);
