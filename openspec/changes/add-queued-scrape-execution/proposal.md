# Proposal

## Why

The PRD has the scheduler call `POST /internal/sites/{siteId}/refresh`, which runs the site's Puppeteer script inside the Nest app. That ties headless Chromium to the API process, gives manual and scheduled refreshes no shared path, and has no defence against a run that dies halfway: reconciliation deletes products missing from a scrape, so a truncated run would wipe catalog data. The product has since become a multi-tenant service where customers define their own schemas and approve what discovery produces, so execution must also run a declarative selector spec (not generated code), convert raw site text into typed values, support a non-persisting preview, and stay consistent with schema changes.

## What Changes

- Scheduled, on-demand and preview requests become messages on an SQS queue (FIFO, deduplicated per site for production and per site and spec version for previews); each creates a run record.
- `POST /internal/sites/{siteId}/refresh` stops running a scrape; it enqueues one for the site's active spec version and returns `202` with the `runId`. A new `POST /internal/sites/{siteId}/preview` enqueues a limited, non-persisting run of a candidate spec version.
- **BREAKING (vs. the PRD):** the "generated script" becomes a **selector spec**, a declarative JSON document (navigation, pagination, item and property bindings, transforms) executed by one fixed, tested runner. Nothing from the spec is executed as code. A new `selector-spec` capability defines the format that discovery must produce.
- A scrape worker, packaged as one container image, loads the spec from S3, runs it with Puppeteer (no MCP, no LLM), converts raw text into typed values with the spec's transforms, and writes `{raw, value, issues}` per item to S3 under the owning customer's prefix.
- Reconciliation receives only typed values, and only from complete production runs: finished in time, item count within range of the previous complete run, and parse success per property above a minimum. Timeouts, count or parse anomalies, spec/schema mismatches and stale schema versions fail the run and delete nothing.
- The worker stays outside the VPC with no database access; the API owns run records, dedupe and the completeness checks, consuming a results queue.
- Runs pin the catalog's schema version; a run whose schema moved while it ran is rejected as stale.
- Initial runtime is SQS to Lambda (container image, capped concurrency), with a documented switch to SQS to Fargate `RunTask` when a site's measured run time approaches the Lambda limit.
- Raw results expire after 30 days (configurable); typed values live in PostgreSQL.
- The PRD's automatic re-discovery on failure is replaced by publishing `failed_scrape`; consumers (customer notification, attention markers) come in later changes.

## Capabilities

### New Capabilities
- `scrape-triggering`: how scrapes and previews are requested, recorded, deduplicated and acknowledged, and how per-site schedules are managed.
- `scrape-execution`: how a queued run executes a spec, records raw and typed values, decides completeness, hands results to reconciliation, previews, and reports failures.
- `selector-spec`: the declarative, versioned format of a site's selector spec, including its closed vocabularies of steps and transforms.

### Modified Capabilities

None. `openspec/specs/` is empty.

## Impact

- New code: scrape worker (container entrypoint), selector-spec validator and runner, transform library, queue producer, results consumer and run finalizer, schedule manager; the internal endpoint changes from synchronous scrape to enqueue, plus a preview endpoint.
- Depends on `add-catalog-persistence` for sites, catalogs and schema versions (version-pinned writes), and adds a `scrape_runs` table.
- Interim assumption: until the discovery and activation change introduces the active-spec pointer, the active version of a site is resolved from an `active.json` pointer object next to its spec versions in S3.
- Dependencies: AWS SDK (SQS, S3, EventBridge Scheduler), `puppeteer-core`, `@sparticuz/chromium`.
- Infrastructure (AWS): scrape queue and DLQ, results queue, S3 bucket with lifecycle rule, Lambda or ECS task definition, IAM; schedules are created at runtime per site rather than as static rules.
- Not in scope: discovery and spec generation, customer-facing triggers and authentication, the reconcile rules themselves, budgets, notifications of failed scrapes.
