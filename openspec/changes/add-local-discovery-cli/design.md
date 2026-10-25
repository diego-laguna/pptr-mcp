## Context

`DiscoveryWorker` already takes every outside dependency by injection: an `ObjectStore`, a `SpecStore`, a publisher, a browser launcher and an `agent` function. `LocalFileObjectStore` and `ChromiumLauncher` (which honors `CHROME_PATH`) exist. Only `src/discovery/worker/main.ts` hard-wires S3 and SQS. The CLI is therefore a second composition root, not new logic.

## Goals / Non-Goals

**Goals**
- Exercise the real model and real sites with the production worker code.
- Need only Node, Chrome and model credentials.
- Fail before spending when inputs are wrong.

**Non-Goals**
- No API, database, activation or scheduling locally.
- No change to discovery behavior, spec format or caps used in production.

## Decisions

1. **Reuse `DiscoveryWorker`, build a `DiscoveryMessage` by hand.** The CLI fills the message from flags: a fresh attempt id, mode, site URL, schema snapshot, target properties, guidance, caps and an `outputPrefix`. Base spec for incremental/repair is written into the local store and referenced by `baseSpecKey`. Alternative, a parallel simplified runner, was rejected because it would stop testing the code that ships.
2. **Schema file is a full `CatalogSchema`** (`{ "properties": [...] }`, including `filterable` and the `variant` flag), validated with the existing `parseSchema` so the same rules and error paths as the catalog apply, and so seed or exported catalog schemas can be used as they are. The CLI derives the `SchemaSnapshot` the worker needs from it the same way production does: drop `filterable`, set `variantProperty` to the name of the property flagged `variant`, and use `schemaVersion` 1 (overridable with `--schema-version`). Production has no such function today: the mapping is inline in `AttemptsRepository.siteForDiscovery`, which reads the variant from a separate `variant_property` column. The change extracts a pure `snapshotFromSchema(schema, schemaVersion)` into `src/discovery/api/`, and the repository and the CLI both call it, so the CLI cannot drift from production. Repository behavior stays identical and its existing tests cover it. An example file ships in `docs/`.
3. **Local-file store under `.local-discovery/<attemptId>/`**, configurable by `--out`. The attempt id is a timestamped uuid so runs never collide. Evidence and candidate keys then match production layout, so the same inspection habits apply.
4. **In-process publisher** collects `started` and the final `FinishedAttempt`; the CLI prints from the final message and exits non-zero unless the outcome is `candidate`.
5. **Private-address flag (`--allow-private`).** The worker already accepts `resolveHost` and `guardOptions.isBlocked`; the flag swaps these to permit loopback and private ranges only. Metadata addresses (`169.254.169.254`) stay blocked even with the flag. The domain confinement and scheme checks are untouched. The flag is a CLI option only, never read from the environment, so it cannot be set by accident in a deployed image; the CLI is not included in the worker images.
6. **Credential preflight.** Accept `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_USE_BEDROCK=1` with AWS credentials resolvable. Checked before launching Chrome. Whether Bedrock or the API is the production choice stays open (task 5.4); the CLI does not decide it.
7. **Default local caps** are lower than production: 15 turns, 5 minutes, 1 USD, overridable with `--max-turns`, `--max-minutes`, `--max-cost`. They are printed at start and every run reports actual usage, which feeds the decision on production defaults.
8. **Argument parsing with `node:util` `parseArgs`**; no new dependency. Run through `tsx` or the built output, whichever the repo already uses for the seed script (built output, `node dist/...`).

## Risks / Trade-offs

- Real runs cost money and touch third-party sites. Mitigation: low default caps, cost printed first, README warns to use sites one may scrape.
- `--allow-private` weakens SSRF protection if misused. Mitigation: explicit flag, printed notice, metadata addresses still blocked, not in deployed images.
- Local Chrome differs from the Lambda/Fargate Chromium, so rendering can differ slightly. Accepted; the point is model behavior.
- Tests cannot call the real model. The CLI is tested with the scripted agent through an injectable agent factory; the real path is covered by a manual run documented in the tasks.

## Open Questions

- None blocking. Whether to later add a `--replay` of saved evidence is left out.
