import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validSpec } from '../../scrape/spec/spec-fixtures.js';
import { LocalOptions, parseLocalArgs, UsageError } from './args.js';
import { missingCredentials } from './credentials.js';
import { InputError, loadInputs } from './inputs.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-inputs-'));
});

const prop = (name: string, extra: object = {}) => ({
  name,
  type: 'string',
  description: name,
  required: false,
  filterable: true,
  ...extra,
});
async function file(name: string, content: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(
    path,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  return path;
}
async function options(
  patch: Partial<LocalOptions> = {},
): Promise<LocalOptions> {
  return {
    url: 'https://shop.example',
    schemaFile: await file('schema.json', {
      properties: [
        prop('launch'),
        prop('fabric'),
        prop('size', { variant: true }),
      ],
    }),
    schemaVersion: 1,
    mode: 'full',
    properties: [],
    guidance: null,
    baseFile: null,
    outDir: dir,
    allowPrivate: false,
    maxTurns: 15,
    maxMinutes: 5,
    maxCostUsd: 1,
    model: undefined,
    ...patch,
  };
}

describe('parseLocalArgs', () => {
  const argv = (...rest: string[]) => [
    'https://shop.example',
    '--schema',
    's.json',
    ...rest,
  ];

  it('applies the local defaults', () => {
    expect(parseLocalArgs(argv(), {})).toMatchObject({
      mode: 'full',
      maxTurns: 15,
      maxMinutes: 5,
      maxCostUsd: 1,
      allowPrivate: false,
      outDir: '.local-discovery',
      schemaVersion: 1,
    });
  });

  it('takes overrides, comma lists and the model from the environment', () => {
    expect(
      parseLocalArgs(
        argv(
          '--mode',
          'incremental',
          '--base',
          'b.json',
          '--properties',
          'a,b',
          '--properties',
          'c',
          '--max-cost',
          '2.5',
          '--allow-private',
        ),
        { DISCOVERY_MODEL: 'm1' },
      ),
    ).toMatchObject({
      mode: 'incremental',
      properties: ['a', 'b', 'c'],
      maxCostUsd: 2.5,
      allowPrivate: true,
      model: 'm1',
    });
  });

  it('answers help with null', () => {
    expect(parseLocalArgs(['--help'], {})).toBeNull();
  });

  it.each([
    [[], /exactly one site URL/],
    [['https://x.example'], /--schema is required/],
    [argv('--mode', 'bogus'), /--mode must be one of/],
    [argv('--mode', 'incremental'), /--base is required/],
    [argv('--mode', 'repair'), /--base is required/],
    [argv('--base', 'b.json'), /only applies/],
    [argv('--max-turns', '0'), /positive/],
    [argv('--unknown'), /unknown/i],
  ])('rejects %j', (args, message) => {
    expect(() => parseLocalArgs(args as string[], {})).toThrow(UsageError);
    expect(() => parseLocalArgs(args as string[], {})).toThrow(message);
  });
});

describe('missingCredentials', () => {
  it('accepts an API key or the Bedrock switch', () => {
    expect(missingCredentials({ ANTHROPIC_API_KEY: 'k' })).toBeNull();
    expect(missingCredentials({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBeNull();
  });
  it('names the variables to set otherwise', () => {
    expect(missingCredentials({})).toMatch(
      /ANTHROPIC_API_KEY.*CLAUDE_CODE_USE_BEDROCK/,
    );
    expect(missingCredentials({ CLAUDE_CODE_USE_BEDROCK: '0' })).not.toBeNull();
  });
});

describe('loadInputs', () => {
  it('derives the snapshot from a catalog schema', async () => {
    const loaded = await loadInputs(await options({ schemaVersion: 4 }));
    expect(loaded.snapshot.schemaVersion).toBe(4);
    expect(loaded.snapshot.variantProperty).toBe('size');
    expect(JSON.stringify(loaded.snapshot)).not.toContain('filterable');
    expect(loaded.targets).toEqual([]);
  });

  it('has no variant property when none is flagged', async () => {
    const schemaFile = await file('plain.json', {
      properties: [prop('launch')],
    });
    expect(
      (await loadInputs(await options({ schemaFile }))).snapshot
        .variantProperty,
    ).toBeNull();
  });

  it.each([
    ['missing', undefined, /could not be read/],
    ['not json', '{nope', /not valid JSON/],
    [
      'unknown type',
      { properties: [prop('x', { type: 'blob' })] },
      /properties\[0\]/,
    ],
    ['reserved name', { properties: [prop('price')] }, /price/],
    [
      'two variants',
      {
        properties: [
          prop('a', { variant: true }),
          prop('b', { variant: true }),
        ],
      },
      /at most one variant/,
    ],
  ])('names the problem for a %s schema file', async (_n, content, message) => {
    const schemaFile =
      content === undefined
        ? join(dir, 'absent.json')
        : await file(`bad-${_n}.json`, content);
    const run = loadInputs(await options({ schemaFile }));
    await expect(run).rejects.toBeInstanceOf(InputError);
    await expect(run).rejects.toThrow(message);
  });

  it('names an unknown target property', async () => {
    const baseFile = await file('base.json', validSpec());
    await expect(
      loadInputs(
        await options({
          mode: 'incremental',
          baseFile,
          properties: ['colour'],
        }),
      ),
    ).rejects.toThrow(/colour/);
  });

  it('defaults incremental targets to the properties the base leaves unbound', async () => {
    const baseFile = await file('base.json', validSpec()); // binds `launch`
    const loaded = await loadInputs(
      await options({ mode: 'incremental', baseFile }),
    );
    expect(loaded.targets).toEqual(['fabric', 'size']);
    expect(loaded.base).not.toBeNull();
  });

  it('requires named properties for a repair and checks the base spec', async () => {
    const baseFile = await file('base.json', validSpec());
    await expect(
      loadInputs(await options({ mode: 'repair', baseFile })),
    ).rejects.toThrow(/name the properties/);
    const loaded = await loadInputs(
      await options({ mode: 'repair', baseFile, properties: ['launch'] }),
    );
    expect(loaded.targets).toEqual(['launch']);

    const broken = await file('broken.json', { formatVersion: 99 });
    await expect(
      loadInputs(
        await options({
          mode: 'repair',
          baseFile: broken,
          properties: ['launch'],
        }),
      ),
    ).rejects.toThrow(/base spec/);
  });
});
