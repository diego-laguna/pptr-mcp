# Proposal

## Why

The product's core step is turning a customer's site URL and their own schema (typed, described properties) into a selector spec that the fixed runner can execute without AI. The PRD sketches this as "Claude drives a browser and writes a script", but customers are external, their sites and the pages' text are untrusted, every attempt costs money, and nothing may reach a customer or the catalog unless it has been verified against the live site. `add-queued-scrape-execution` defines the selector-spec format and the runner; this change produces specs in that format.

## What Changes

- A discovery request (`POST /internal/sites/{siteId}/discoveries`) creates an attempt for a site, in `full` mode, `incremental` mode (only the properties still unbound, for example after a `property_pending` marker) or `repair` mode (only bound properties whose locators have stopped working, for example after a site redesign), with optional free-text guidance, and returns `202` with an `attemptId`. Customer-facing triggers come with the accounts change.
- An attempt pins a snapshot of the catalog schema (property names, types, descriptions, examples, enum values, variant property) and runs on a discovery worker (Claude Agent SDK driving the Puppeteer MCP) fed by an SQS queue with at most 2 concurrent workers.
- The agent's tool set is fixed (browser tools plus a few spec tools); page content is treated as untrusted data; browsing is confined to the target site and blocked from private address ranges; the site URL is validated against SSRF before anything is queued.
- The agent's only output is a candidate selector spec submitted through a validating tool. The candidate is then **verified by the real runner against the live site** (same code as production and preview), with checks on item count, system-field coverage, link validity and per-property parse rates. Failures are fed back for a bounded number of repair rounds.
- Properties the agent cannot locate with confidence are left unbound and reported as unresolved with a reason; they are never guessed.
- Incremental mode keeps existing bindings byte-for-byte and proves via a regression check that existing properties still produce the same values.
- Repair mode replaces only the targeted bindings of the site's active spec and keeps every other binding, the system fields, steps and pagination unchanged, with the same regression check; the result is a new version, so a redesign that breaks two properties does not put the working ones at risk.
- Each attempt is capped (turns, duration, cost) and records its usage; an admission hook lets the later budgets change refuse attempts.
- Successful attempts create a new immutable spec version for the site in S3 with a per-site number and a database record, plus an evidence bundle (sample rows with raw and typed values, match counts, parse rates, locator-stability warnings, unresolved properties, and annotated screenshots that outline each bound element with its property name so a customer can check the bindings visually). Creating a version never activates it.
- The PRD's automatic re-discovery on repeated scrape failure is dropped; discovery only runs when requested.

## Capabilities

### New Capabilities
- `discovery-requests`: how a discovery attempt is requested, validated, pinned to a schema, admitted, queued, bounded and recorded.
- `discovery-agent`: what a discovery run is allowed to do, how it treats untrusted pages, how its candidate spec is verified, and what evidence and failure reasons it reports.
- `spec-versions`: immutable, numbered, privately stored selector spec versions and their records.

### Modified Capabilities

None. `openspec/specs/` is empty.

## Impact

- New code: discovery API module, attempt records and finalizer, discovery worker (agent configuration, in-process spec tools, URL and request guards), verifier built on the runner library, spec version store.
- Depends on `add-catalog-persistence` (sites, catalog schemas and versions) and `add-queued-scrape-execution` (selector-spec format, runner, preview limits, results queue pattern).
- New tables: `discovery_attempts`, `site_spec_versions`. Marker clearing and the active-spec pointer stay with the later preview and activation change.
- Dependencies: Claude Agent SDK, Puppeteer MCP server, the runner package; model access via Amazon Bedrock or the Anthropic API (see design).
- Infrastructure (AWS): discovery queue and DLQ, ECS Fargate service scaled by queue depth (0 to 2), task role limited to its S3 prefix and queues, no database access, S3 evidence prefix.
- Not in scope: customer-facing API and authentication, sample approval and activation, budget ledger and quotas, notifications, structured-data sources such as JSON-LD (the spec vocabulary is CSS/XPath only for now).
