import {
  LOCAL_DEFAULT_CAPS,
  LocalOptions,
  parseLocalArgs,
  USAGE,
  UsageError,
} from './args.js';
import { missingCredentials } from './credentials.js';
import { InputError, loadInputs } from './inputs.js';
import { LocalRunDeps, LocalRunResult, runLocalDiscovery } from './run.js';

export interface CliDeps extends LocalRunDeps {
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
}

function describeCaps(o: LocalOptions): string {
  const defaults =
    o.maxTurns === LOCAL_DEFAULT_CAPS.maxTurns &&
    o.maxMinutes === LOCAL_DEFAULT_CAPS.maxMinutes &&
    o.maxCostUsd === LOCAL_DEFAULT_CAPS.maxCostUsd;
  return `caps: ${o.maxTurns} turns, ${o.maxMinutes} min, $${o.maxCostUsd}${defaults ? ' (local defaults)' : ''}`;
}

export function formatReport(o: LocalOptions, r: LocalRunResult): string[] {
  const { final } = r;
  const lines: string[] = [];
  if (final.outcome === 'candidate') lines.push('outcome: candidate');
  else if (final.outcome === 'failed') {
    lines.push(`outcome: failed (${final.reason})`);
    if (final.detail) lines.push(`detail: ${final.detail}`);
  }
  const usage = 'usage' in final ? final.usage : undefined;
  if (usage) {
    const cost =
      usage.costUsd === undefined ? 'unknown' : `$${usage.costUsd.toFixed(2)}`;
    lines.push(
      `usage: ${usage.turns} turns, ${(usage.durationMs / 1000).toFixed(1)} s, cost ${cost}`,
    );
  }
  if (o.allowPrivate)
    lines.push('note: private addresses were allowed (--allow-private)');
  lines.push(`output: ${r.runDir}`);
  return lines;
}

/** Runs the whole command and returns the exit code; nothing here exits the process. */
export async function runCli(
  argv: string[],
  deps: CliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const env = deps.env ?? process.env;
  try {
    const options = parseLocalArgs(argv, env);
    if (!options) {
      out(USAGE);
      return 0;
    }
    const inputs = await loadInputs(options);
    if (!deps.agent) {
      const missing = missingCredentials(env);
      if (missing) {
        out(`error: ${missing}`);
        return 2;
      }
    }
    out(describeCaps(options));
    if (options.allowPrivate)
      out(
        'warning: --allow-private is on; loopback and private addresses are reachable',
      );
    const result = await runLocalDiscovery(options, inputs, deps);
    for (const line of formatReport(options, result)) out(line);
    return result.final.outcome === 'candidate' ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      out(`error: ${error.message}`);
      out(USAGE);
      return 2;
    }
    if (error instanceof InputError) {
      for (const p of error.problems) out(`error: ${p}`);
      return 2;
    }
    out(`error: ${(error as Error).message}`);
    return 1;
  }
}
