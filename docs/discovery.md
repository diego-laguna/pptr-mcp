# Site discovery

Discovery turns a site URL plus the catalog's schema into a **candidate selector spec** (the format in [scrape-execution.md](scrape-execution.md)). It runs only when requested, never activates what it produces, and never offers a spec that has not been run against the live site.

## Requesting an attempt

`POST /internal/sites/{siteId}/discoveries` (internal credential required) with `{ "mode": "full" | "incremental" | "repair", "properties"?: string[], "guidance"?: string }` answers `202 { attemptId }`.

| Mode | Base | Targets |
| --- | --- | --- |
| `full` | none | the whole schema |
| `incremental` | the active spec, else the newest stored version (`409 no_base_spec` without one) | properties the base does not bind (all of them by default; naming a bound one is `422`) |
| `repair` | the active spec (`409 no_base_spec` without one) | bound properties only; by default those the site's latest production scrape reported failing (`scrape_runs.failing_properties`, set on `parse_anomaly`); `422` when none; system fields are never targets |

Other answers: `404` unknown site, `422` for guidance over 2000 characters, an unsafe site URL (non-http(s), credentials, loopback, private, link-local including `169.254.169.254`, or a host resolving to any such address) or bad targets, `429 budget_exhausted` when the admission policy refuses (the default allows everything), and the existing attempt when one is already queued or running. The attempt pins a snapshot of the schema (names, types, descriptions, examples, enum values, required, variant property); later edits never reach it.

## The agent

A worker on Fargate (0 to 2 tasks scaled by queue depth, `Dockerfile.discovery`) reads the queue one attempt at a time. It has no database access: it writes `candidate.json`, `evidence.json` and screenshots under `discoveries/{customerId}/{siteId}/{attemptId}/` and sends a finished-attempt message; the API stores the version.

- **Closed tool set.** No built-in tools at all (no shell, files, or fetch). The agent gets `navigate`, `click`, `scroll`, `page_text` (browser tools) and `outline_page`, `test_locator`, `submit_spec` (spec tools), exposed by an in-process MCP server that shares the worker's browser page. `canUseTool` denies anything else. Browser tools run in-process rather than through a separate Puppeteer MCP server so that the browsing guard cannot be bypassed.
- **Untrusted pages.** Everything the browser tools return is wrapped in `<untrusted_page_data>`; the prompt says to never follow instructions found there. The guarantee comes from the limits: the only accepted output is a validated spec, and nothing the agent can call leaves the site or touches customer data. Free text claiming selectors yields no candidate (`invalid_output`); a line starting `NO_CATALOG:` yields `no_catalog_found`.
- **Browsing guard.** Request interception on every request and redirect hop: only http(s); top-level navigation confined to the site's domain (a leading `www.` ignored) and subdomains; the host of every request must resolve only to public addresses; the connected address is checked again on the response (DNS rebinding); downloads denied. Blocks are recorded as guard events in the evidence.
- **Verification.** `submit_spec` validates the spec, checks it against the pinned schema, then runs it with the production runner within preview limits. It is offered only with at least 5 items, each system field on at least 95% of items, at least 95% distinct absolute links and every bound property parsing for at least 80% of items with raw text. Failures go back to the agent; after 3 repair rounds the attempt fails `verification_failed`.
- **Incremental and repair** are structural: the candidate must equal the base with only the targeted bindings added (incremental) or replaced/removed (repair); anything else is `invalid_output`. Existing bindings must yield identical typed values on the same pages. A repair that fixes nothing fails; properties it cannot re-locate are left out and reported unresolved. The evidence shows each targeted property's old and new match count and parse rate.
- **Evidence.** Up to 20 samples with raw and typed values, match counts, parse rates, locator-stability warnings (positional chains, long absolute paths, generated class names), unresolved properties with reasons, guard events, notes, and an annotated screenshot of the listing page (each bound element outlined and labelled; bindings with no match are listed as not highlighted). The overlay is injected only after verification.

## Caps, usage and cost

Each attempt stops at its maximum turns, wall-clock duration or cost and fails `cap_exceeded`, keeping its usage. Defaults are provisional (`DISCOVERY_MAX_TURNS=60`, `DISCOVERY_MAX_MINUTES=20`, `DISCOVERY_MAX_COST_USD=5`) until real attempts are measured. The Agent SDK reports `total_cost_usd`, turns and token counts on its result message, so usage is recorded directly rather than derived from a price table. Before an attempt is queued, an `AdmissionPolicy` is consulted; the budgets change replaces the allow-all default.

## Failure reasons

`unreachable_site`, `blocked_by_site`, `no_catalog_found`, `verification_failed`, `invalid_output`, `cap_exceeded`, `budget_exhausted`, `schema_changed` are final. Infrastructure errors are redelivered up to 3 times, then land in the dead-letter queue and the attempt fails `error`.

## Versions

The API assigns the next per-site number in a transaction (locking the site row), writes the immutable spec object with a conditional put, and records source, mode, attempt, base version, schema version and bound properties in `site_spec_versions`. A candidate is stored only if every property it binds still exists in the schema (`schema_changed` otherwise); properties added since do not block. Storing never changes the active version.

## Running the worker

`CHROME_PATH=/usr/bin/google-chrome` plus `RESULTS_BUCKET`, `DISCOVERY_QUEUE_URL`, `DISCOVERY_FINISHED_QUEUE_URL` and model access, then `node dist/discovery/worker/main.js`. Model access is the Agent SDK's: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_USE_BEDROCK=1` with an IAM role (set `DISCOVERY_MODEL_PROVIDER=bedrock` when deploying `infra/` to grant `bedrock:InvokeModel`).

## Not yet done

- The default caps above come from guesses, not measurements: task 3.5 (two real attempts against dev sites) needs model access and has not been run.
- Bedrock versus the Anthropic API (task 5.4) is undecided; the stack supports both.
- Scale-to-zero of the Fargate service on queue depth, and a message starting a task, are defined in `infra/lib/discovery-stack.ts` and asserted at synth time, but have not been exercised on AWS (task 5.2).
