import { runCli } from './cli.js';

/** `pnpm discover:local`: one discovery attempt on this machine. */
if (process.argv[1]?.endsWith('discovery/local/main.js')) {
  process.exitCode = await runCli(process.argv.slice(2));
}
