import { parseArgs } from 'node:util';
import { DISCOVERY_MODES, DiscoveryMode } from '../api/types.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface LocalOptions {
  url: string;
  schemaFile: string;
  schemaVersion: number;
  mode: DiscoveryMode;
  properties: string[];
  guidance: string | null;
  baseFile: string | null;
  outDir: string;
  allowPrivate: boolean;
  maxTurns: number;
  maxMinutes: number;
  maxCostUsd: number;
  model: string | undefined;
}

/** Lower than production: a first look at a site should be cheap. */
export const LOCAL_DEFAULT_CAPS = {
  maxTurns: 15,
  maxMinutes: 5,
  maxCostUsd: 1,
} as const;

export const USAGE = `Usage: pnpm discover:local <site-url> --schema <catalog-schema.json> [options]

  --mode <full|incremental|repair>   default full
  --properties <a,b>                 target properties (incremental, repair)
  --base <spec.json>                 base spec (required for incremental, repair)
  --guidance <text>                  hint for the agent
  --schema-version <n>               default 1
  --out <dir>                        output root, default .local-discovery
  --max-turns <n>                    default ${LOCAL_DEFAULT_CAPS.maxTurns}
  --max-minutes <n>                  default ${LOCAL_DEFAULT_CAPS.maxMinutes}
  --max-cost <usd>                   default ${LOCAL_DEFAULT_CAPS.maxCostUsd}
  --model <id>                       default: DISCOVERY_MODEL or the SDK default
  --allow-private                    allow loopback and private addresses (local fixtures only)
  --help

Model access: set ANTHROPIC_API_KEY, or CLAUDE_CODE_USE_BEDROCK=1 with AWS credentials.
Chrome: set CHROME_PATH to a Chrome binary.`;

function positive(name: string, raw: string | undefined, fallback: number) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new UsageError(`${name} must be a positive number`);
  return value;
}

/** Returns null when help was requested. Throws UsageError for anything unusable. */
export function parseLocalArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): LocalOptions | null {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        schema: { type: 'string' },
        'schema-version': { type: 'string' },
        mode: { type: 'string' },
        properties: { type: 'string', multiple: true },
        base: { type: 'string' },
        guidance: { type: 'string' },
        out: { type: 'string' },
        'allow-private': { type: 'boolean' },
        'max-turns': { type: 'string' },
        'max-minutes': { type: 'string' },
        'max-cost': { type: 'string' },
        model: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return null;
  if (positionals.length !== 1)
    throw new UsageError('exactly one site URL is required');
  if (!values.schema) throw new UsageError('--schema is required');

  const mode = (values.mode ?? 'full') as DiscoveryMode;
  if (!DISCOVERY_MODES.includes(mode))
    throw new UsageError(`--mode must be one of ${DISCOVERY_MODES.join(', ')}`);
  if (mode !== 'full' && !values.base)
    throw new UsageError(`--base is required for ${mode}`);
  if (mode === 'full' && values.base)
    throw new UsageError('--base only applies to incremental and repair');

  const schemaVersion = positive(
    '--schema-version',
    values['schema-version'],
    1,
  );
  if (!Number.isInteger(schemaVersion))
    throw new UsageError('--schema-version must be a whole number');

  return {
    url: positionals[0],
    schemaFile: values.schema,
    schemaVersion,
    mode,
    properties: (values.properties ?? [])
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean),
    guidance: values.guidance?.trim() || null,
    baseFile: values.base ?? null,
    outDir: values.out ?? '.local-discovery',
    allowPrivate: values['allow-private'] === true,
    maxTurns: positive(
      '--max-turns',
      values['max-turns'],
      LOCAL_DEFAULT_CAPS.maxTurns,
    ),
    maxMinutes: positive(
      '--max-minutes',
      values['max-minutes'],
      LOCAL_DEFAULT_CAPS.maxMinutes,
    ),
    maxCostUsd: positive(
      '--max-cost',
      values['max-cost'],
      LOCAL_DEFAULT_CAPS.maxCostUsd,
    ),
    model: values.model ?? env.DISCOVERY_MODEL,
  };
}
