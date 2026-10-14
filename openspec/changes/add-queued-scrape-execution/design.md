# Design

## Context

See proposal.md. Current state: the repo is the bare Nest (Fastify) scaffold; no scraper, queue or AWS code exists, and `add-catalog-persistence` (not yet applied) defines customers, catalogs with versioned schemas, and sites. The PRD puts an SQS `failed_scrape` queue (redrive `maxReceiveCount: 3`) in the architecture and AWS is the target. Scrape duration per site is not measured; the Lambda limit is 900 s. Lambda async invoke and SQS messages cap at 256 KB, sync invoke at 6 MB. Customers are external, catalogs are private, and discovery (a later change) produces selector specs that customers approve before activation.

## Goals / Non-Goals

**Goals:**
- One entry path for scheduled, on-demand and preview scrapes.
- A worker that runs unchanged on Lambda or Fargate.
- No catalog change from a run that did not finish, parsed badly, or went stale.
- A spec format that is safe to execute and easy for discovery to target.

**Non-Goals:**
- The discovery service, spec generation and the customer approval flow.
- Reconcile rules (insert/delete/availability), customer-facing APIs and authentication.
- Fan-out of one site's scrape across invocations (escape hatch only).

## Decisions

**1. Queue in front, worker behind, regardless of runtime.** EventBridge Scheduler, the refresh endpoint and the preview endpoint all create a run record and send one message to an SQS FIFO queue. Alternative: Scheduler invoking Lambda directly; simpler for cron alone but leaves on-demand and preview without a shared path, dedupe or a concurrency knob.

**2. The API owns state; the worker is stateless and has no database access.** The worker runs outside the VPC (no NAT or RDS Proxy needed, and it cannot reach private resources). So the message carries everything it needs: `{runId, mode, customerId, catalogId, siteId, specKey, schemaVersion, limits}`. The API creates the `scrape_runs` row at enqueue time, with partial unique indexes where status is `queued` or `running` (production: one per `site_id`; preview: one per `(site_id, spec_version)`, so a preview of a newer candidate is never answered with the run of an older one), which is the dedupe that survives FIFO's 5-minute window. When the worker finishes it writes the result to S3 and sends `{runId, outcome, reason, resultKey, stats}` to a results queue; the API consumes it, applies the checks that need history, reconciles or fails the run, and publishes `failed_scrape`. Alternative: the worker updates PostgreSQL; requires VPC, NAT and RDS Proxy. This replaces the earlier draft, where the worker took a database run lock.

**3. FIFO scrape queue with `MessageGroupId = siteId` and a dedup id of `siteId:production` or `siteId:preview:version`.** Serializes runs of one site (including previews of different versions, which are accepted together and execute one after another) and drops duplicates inside the dedupe window; the unique indexes cover the rest.

**4. Selector spec plus a fixed runner, not generated scripts.** Discovery output is a JSON document in a closed vocabulary (steps, pagination, locators, transforms) validated against a schema; the runner interprets it. Specs are immutable versions at `customers/{customerId}/sites/{siteId}/specs/{version}.json` in a versioned bucket. Benefits: no LLM-authored code runs under the worker's IAM role, specs are diffable and testable, and rename/remove of a schema property can rewrite a spec deterministically in a later change. Cost: odd sites may need new step types, which are added to the vocabulary deliberately. Alternative: LLM-written scripts, matching the PRD wording; rejected for safety once customers' sites and prompts are untrusted input.

**5. Active spec resolved through a port, interim `active.json` pointer in S3.** The API resolves a site's active version when enqueuing. Until the discovery and activation change owns the pointer, it reads `active.json` next to the versions (a single-object write, atomic). That change can move the pointer into PostgreSQL behind the same port.

**6. Raw and typed values both recorded, raw only in S3.** The result stores, per item and property, `raw`, `value` and `issues`. Transforms live in the spec because formats differ per site (`dd/MM` vs `MM/dd`, `12.990,50` vs `12,990.50`) while the schema is shared. A failed transform omits the property and records the raw text, following the PRD rule to leave a value out rather than guess. Reconciliation reads only `value`. Raw results expire by an S3 lifecycle rule (30 days). Alternatives: raw alongside typed in PostgreSQL (doubles row size, mixes run output into the main store) or typed only (loses data on parser fixes and blinds debugging).

**7. Completeness gate split by where the data lives.** The worker establishes `finished` and deadline compliance. The API, which has run history, applies the count-deviation check against the previous complete run and the parse-rate check (per property, parsed over present raw values, minimum default 80%), then reconciles or fails. Alternative: send history to the worker in the message; couples message shape to history and duplicates the logic.

**8. Pin the schema version at enqueue; fail on mismatch or staleness.** The run records the catalog's schema version when requested. The worker rejects a spec that binds a property absent from that schema (`schema_mismatch`, for example after a rename before the spec is rewritten); a property added to the schema but not bound is fine. When the result arrives, the API compares the pinned version with the current one and fails stale runs, which the persistence write path also enforces.

**9. Preview is the same runner with limits and no side effects.** Same spec, same transforms, bounded pages and items, result stored for the customer to view with raw next to typed, no reconciliation, no `failed_scrape`. This makes the preview a real test of the production path. Alternative: a separate preview implementation; rejected, since it could pass while production fails.

**10. Runtime: SQS to Lambda (container image), concurrency capped via the event source mapping.** Scales to zero, no cluster, and assumes scheduled runs stay under the limit. Visibility timeout at least 6x the function timeout. Fallback: SQS to Fargate `RunTask` with the same image and a visibility heartbeat. **Switch criterion:** any site whose measured p95 run time exceeds about 10 minutes. Alternative: always-on Fargate worker; rejected for idle cost and heartbeat complexity.

**11. Deadline-aware worker.** It reads remaining time, stops with a safety margin and reports `timeout` instead of being killed, and closes the browser cleanly.

**12. Retry only what can succeed on retry.** Browser crashes and network errors are transient: the message is redelivered up to 3 times, then goes to the DLQ. Deterministic failures (`no_spec`, `invalid_spec`, `schema_mismatch`, `timeout`, `count_anomaly`, `parse_anomaly`, `stale_schema`) are reported and acknowledged without retry. Alternative: retry everything; rejected, since a timeout or an anomaly would only repeat and cost more.

**13. Schedules are created at runtime per site.** A schedule manager creates, updates and deletes one EventBridge Scheduler schedule per site (created on activation by a later change). Alternative: static IaC rules; rejected because sites are now customer-created.

**14. Per-customer S3 prefixes.** Results and specs live under `customers/{customerId}/...`, so API-side access checks can be prefix-based. The worker's single role can read all prefixes, which is acceptable only because it runs no customer-supplied code; the runner never interprets spec content as code.

## Risks / Trade-offs

- [Target sites block AWS datacenter IPs or geo-restrict] → smoke-test the five dev sites early; a fixed-IP NAT is the later mitigation.
- [A site's run time grows past the limit] → deadline-aware failure with a reason; Decision 10's switch criterion moves it to Fargate.
- [The spec vocabulary is too small for some sites] → add step or transform types deliberately with versioned format; unknown types are rejected, never guessed.
- [Parse thresholds block a legitimate change in site wording] → threshold configurable per site; the failure carries the reason and sample raw text for review.
- [The interim `active.json` pointer drifts from the database view of the world] → one writer (operators/tests) until the activation change replaces it.
- [Count-anomaly check blocks a legitimate catalog change, e.g. a sale] → configurable deviation; reason surfaced in `failed_scrape`.
- [Lambda Chromium packaging is fiddly] → validate the container image in an early task.

## Migration Plan

Nothing is deployed yet. Order: build the spec validator, runner and transforms locally against saved HTML fixtures; add run records, queues and the results consumer; add the endpoints and schedule manager; deploy to Lambda; smoke-test the five dev sites with hand-written specs; then enable schedules. Rollback: disable schedules and the event source mapping; stored catalog is untouched.

## Open Questions

- Default count deviation (for example 30%) and parse-rate minimum (80%), both tunable after real runs.
- Where the internal endpoints' service credential lives (PRD open item); does not change this design.
- Whether previews of different versions of one site should also be capped in number while waiting (they are accepted together and execute serially under the site's message group); `add-discovery-preview-and-activation` starts a preview automatically for every stored candidate.
