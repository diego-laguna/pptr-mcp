## Why

Discovery can only be started through the API, SQS, S3 and Fargate, so the one thing the automated tests cannot cover, how the real model behaves on a real site, cannot be tried without deploying. Default caps (task 3.5 of `add-site-discovery`) and the Bedrock-versus-API decision both depend on such runs. A local entrypoint removes the deployment from that loop.

## What Changes

- Add a command-line tool, `pnpm discover:local`, that runs one discovery attempt on the developer's machine against a site URL and a schema file, using the real model and a real Chrome.
- The tool reuses the production `DiscoveryWorker`, browsing guard, verifier and agent runner unchanged. Only the surroundings are local: a local-file object store, an in-process publisher and a locally built discovery message. No database, queue or AWS credentials are involved.
- The tool writes the candidate spec, evidence and annotated screenshots to a local output directory and prints the outcome, turns, duration and cost.
- Modes `full`, `incremental` and `repair` are supported; the latter two take a base spec file.
- Safety checks stay on. A single explicit flag allows loopback and private addresses so a fixture or own site served locally can be used; it is refused unless the tool runs locally and it is printed in the output.
- Document local setup (model credentials, Chrome path, caps) in `docs/discovery.md`.

Out of scope: running the API, database or activation flow locally; the real-model trial itself (task 3.5); changing discovery behavior.

## Capabilities

### New Capabilities
- `local-discovery-cli`: running a single discovery attempt locally from a URL and schema file, with the production worker, local storage and local output.

### Modified Capabilities
<!-- none: discovery requirements are unchanged -->

## Impact

- New: `src/discovery/local/` (CLI entry and wiring), `package.json` script, `docs/discovery.md` section, tests under `test/discovery/`.
- Reads `ANTHROPIC_API_KEY` or Bedrock environment variables, `CHROME_PATH` and `DISCOVERY_MODEL`; no new dependencies expected.
- Makes real model calls when run by a developer, which cost money. Tests use the scripted agent and do not.
