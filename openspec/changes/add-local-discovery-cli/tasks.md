## 1. CLI skeleton and inputs

- [x] 1.0 Extract `snapshotFromSchema(schema, schemaVersion)` from `AttemptsRepository.siteForDiscovery` and use it there, with the variant read from the `variant` flag or the stored column; existing repository tests stay green

- [x] 1.1 Add `src/discovery/local/args.ts`: `parseArgs` options for url, schema file, mode, properties, guidance, base spec file, caps, `--out`, `--allow-private`, with clear usage text
- [x] 1.2 Add `src/discovery/local/inputs.ts`: load the schema file as a `CatalogSchema` and validate it with `parseSchema`, derive the `SchemaSnapshot` with the shared `snapshotFromSchema`, validate the base spec with the existing spec validation, and check target properties against the schema; fail with named problems
- [x] 1.3 Add credential preflight (API key or Bedrock settings) that runs before any browser or model call
- [x] 1.4 Unit tests for arguments, input validation, snapshot derivation (with and without a variant property, `filterable` dropped), mode/base rules and credential preflight

## 2. Wiring

- [x] 2.1 Add `src/discovery/local/run.ts`: build the `DiscoveryMessage`, local-file store under a unique run directory, in-process publisher, `ChromiumLauncher` and `runAgent`, and run `DiscoveryWorker`; take the agent as an injectable factory
- [x] 2.2 Implement `--allow-private` through the worker's `resolveHost` and guard predicate, keeping metadata addresses blocked, and print the notice when on
- [x] 2.3 Print caps at start and outcome, turns, duration, cost and output paths at the end; exit non-zero unless a candidate was produced
- [x] 2.4 Add `src/discovery/local/main.ts` entrypoint and the `discover:local` script in `package.json`; confirm the CLI is not copied into the worker images

## 3. Tests

- [x] 3.1 Integration test with the scripted agent, real Chrome and the fixture server: full run writes candidate, evidence and screenshots; second run uses a new directory
- [x] 3.2 Test private address refused by default and allowed with the flag, and that cross-domain navigation is still blocked with the flag on
- [x] 3.3 Test incremental and repair with a base spec, and the missing-base failures before any agent call
- [x] 3.4 Test cap reached produces `cap_exceeded` with usage reported and a non-zero exit

## 4. Documentation and manual check

- [x] 4.1 Add a local-run section to `docs/discovery.md` (credentials, `CHROME_PATH`, caps, flag warning, output layout) and an example catalog schema file
- [ ] 4.2 Manual run against a locally served fixture site with a real model and a low cost cap; record turns and cost in the PR description
