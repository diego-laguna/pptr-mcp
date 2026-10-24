# Tasks

## 1. Selector spec and contracts

- [x] 1.1 Add `puppeteer-core`, `@sparticuz/chromium` and AWS SDK (SQS, S3, EventBridge Scheduler) dependencies; verify `pnpm install` and `pnpm build` succeed
- [x] 1.2 Define types and validators for the scrape message (`runId`, `mode`, owner ids, `specKey`, `schemaVersion`, `limits`), the run result (`raw`, `value`, `issues` per item) and the finished-run message with failure reasons (`no_spec`, `invalid_spec`, `schema_mismatch`, `timeout`, `count_anomaly`, `parse_anomaly`, `stale_schema`, `error`); verify unit tests reject malformed messages
- [x] 1.3 Implement the selector spec schema validator (format version, steps and pagination vocabulary with bounded pages, required system-field bindings, locator syntax for CSS and XPath, transform vocabulary, no embedded code); verify unit tests cover every scenario in the selector-spec spec
- [x] 1.4 Implement the spec loader (immutable versions in S3 by key, local-file implementation for tests, rejection of overwriting a stored version); verify tests for found, missing (`no_spec`) and overwrite attempt

## 2. Runner and transforms

- [x] 2.1 Implement the transform library (trim, regex capture, locale number parse, date parse with format and locale producing `YYYY-MM-DD`, text-to-enum map, text-to-boolean map, split); verify unit tests with Argentine formats (`12.990,50`, `15/10/2026`) and failure cases returning an issue
- [x] 2.2 Implement the runner core against local HTML fixtures: item discovery, property extraction by CSS or XPath from text or attribute, variant extraction, and `{raw, value, issues}` output; verify tests on a fixture page for a catalog with and without a variant property
- [x] 2.3 Implement navigation steps and the three pagination modes with page bounds; verify fixture-based tests for next button, URL template and infinite scroll, including stopping at the bound
- [x] 2.4 Implement the schema check (`schema_mismatch` when the spec binds an undeclared property, unbound new properties allowed) and preview limits (pages and items); verify unit tests for both
- [x] 2.5 Implement the deadline-aware execution that stops with a safety margin, closes the browser and returns `timeout`; verify with a fake slow page that no process is left running

## 3. Worker, results and run records

- [x] 3.1 Implement the worker entrypoint (read message, load spec, run, write result to S3 under the owner prefix, send finished-run message, no database access); verify with fake S3 and queues that a large result is passed by reference and the worker makes no database call
- [x] 3.2 Add the `scrape_runs` migration (mode, site, spec version, schema version, status, reason, counts, timestamps) with partial unique indexes for queued or running runs (production: one per site; preview: one per site and spec version); verify tests show a second pending production run for a site is refused, a second preview of the same version is refused, and a preview of another version or a production run alongside a preview is allowed
- [x] 3.3 Implement the results consumer and run finalizer in the API: apply the count-deviation and per-property parse-rate checks against the previous complete run, fail stale schema versions, hand typed values to reconciliation, and update the run record; verify tests for complete, `count_anomaly`, `parse_anomaly`, first run and `stale_schema`
- [x] 3.4 Publish `failed_scrape` events for failed production runs only, with deterministic failures not retried and transient failures redelivered up to 3 times before the DLQ; verify tests for a preview failure (no event), a `timeout` run (event, no reconciliation, stored products untouched) and a repeated transient failure
- [x] 3.5 Document the message contract, run states, failure reasons, completeness rules and result layout in `docs/`; verify the documented example message passes the validator from 1.2

## 4. Triggering

- [x] 4.1 Change `POST /internal/sites/{siteId}/refresh` to resolve the active spec, record a run, enqueue and return `202` with `runId` (`404` unknown site, `409 no_active_spec`, `401/403` without internal credentials); verify e2e tests for each case
- [x] 4.2 Add `POST /internal/sites/{siteId}/preview` for a candidate spec version with page and item limits (`404` for unknown version); verify e2e tests, including that the active spec is unchanged
- [x] 4.3 Make duplicate requests (production per site, preview per site and spec version) return the existing `runId` without enqueuing, with preview allowed during a production run and a preview of a different version getting its own run; verify tests issuing repeated requests
- [x] 4.4 Implement the schedule manager (create, update, delete one EventBridge Scheduler schedule per site producing the same message as the endpoint); verify unit tests compare the scheduled and endpoint payloads and that deletion stops further requests

## 5. Infrastructure (AWS)

- [x] 5.1 Define the FIFO scrape queue (group by site, dedup by site for production and by site and spec version for preview), its DLQ with `maxReceiveCount: 3`, the results queue, a visibility timeout at least 6x the function timeout, and the S3 bucket (versioned, with the 30-day lifecycle rule on raw results); verify the IaC plan or synth shows these settings
- [ ] 5.2 Build the worker container image with Chromium and define the Lambda outside the VPC with capped event-source concurrency, about 2 GB memory and a 900 s timeout; verify the image runs a trivial Puppeteer page load on Lambda
- [x] 5.3 Add IAM roles: worker limited to the bucket prefixes and queues it needs with no database access, API limited to enqueueing, the results queue and the scheduler; verify the worker role cannot reach anything outside its policy
- [x] 5.4 Document the Fargate fallback (same image, `RunTask`, visibility heartbeat) and the switch criterion (p95 run time over about 10 minutes) in `docs/`; verify a reviewer can follow it without reading the design

## 6. Integration

- [ ] 6.1 Write a selector spec by hand for each of the five dev sites, smoke-test them from the deployed runtime and record success, run time, parse rates and any blocking; verify results are written down and decide whether any site needs Fargate
- [x] 6.2 End-to-end check: trigger a refresh, observe the worker run, the S3 result with raw and typed values and the reconciliation input; verify a forced timeout fails the run, deletes nothing and publishes `failed_scrape`, and a preview leaves the catalog unchanged
