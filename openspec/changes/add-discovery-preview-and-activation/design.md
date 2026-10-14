# Design

## Context

See proposal.md. Three in-flight changes define the surroundings. `add-site-discovery` stores immutable per-site spec versions and attempt records and never activates. `add-queued-scrape-execution` provides preview and production runs on one queue path, run records, a schedule manager that creates one schedule per site at runtime, and a port that resolves a site's active version (interim `active.json` in S3). `add-catalog-persistence` provides sites, `site_attention` markers, and catalog schemas with required flags and explicit schema operations (including description edits, which produce a new catalog-wide schema version). There is no authentication yet; endpoints are `/internal/...`.

## Goals / Non-Goals

**Goals:**
- Exactly one place decides what a site's scheduled scrapes run, and it only changes through a checked, recorded action.
- The decision is informed: preview data and discovery evidence are in front of the customer, and gaps are acknowledged, not hidden.
- Activation, marker clearing and history cannot disagree with one another.

**Non-Goals:**
- Screens and customer-facing wording, authentication and ownership checks beyond "scoped to the owning customer".
- Pause and resume of schedules, automatic activation, budgets, reconciliation rules for missing required values.

## Decisions

**1. Active pointer lives in PostgreSQL, one row per site (`site_active_specs`), history in `site_activations`.** The pointer must change in the same transaction as marker clearing and the activation record, which an S3 object cannot do. The scrape change's resolution port gets a database implementation; `active.json` is retired. Alternatives: keep `active.json` and mirror it (two sources of truth); a column on `sites` (works, but the history table is needed anyway and the pointer row keeps `sites` unaware of spec versions).

**2. Activation is one transaction with a compare-and-set.** The request names the version it expects to replace; the transaction locks the site's pointer row (or inserts it for a first activation), checks the expectation (`stale_activation` otherwise), checks the preconditions, writes the new pointer, clears the matching markers and inserts the history row. Repeating an activation of the already-active version is a no-op success. Alternative: last write wins; rejected, since two people reviewing different candidates would silently overwrite each other.

**3. Preview is a recorded precondition, not a flag.** The activation checks that a succeeded preview run record exists for that exact version, and stores its run id on the history row. Specs are immutable, so the preview stays meaningful; the stored sample may expire (raw retention) without invalidating the approval, and the review simply asks for a fresh preview. A version that was active before skips the check, which makes rollback possible when the old preview result is long gone.

**4. Previews start automatically when a version is stored.** The discovery finalizer calls a small hook after storing; the preview costs compute but no model usage, and the review is then ready by the time the customer opens it. Deduping previews per site and mode would answer a request for version 4 with the run of version 3. `add-queued-scrape-execution` has been amended so the preview dedupe key is site plus spec version (partial unique index and FIFO dedup id), keeping one production run per site and one preview per version at a time; this change relies on that and a task verifies it. Alternative: queue the second preview behind the first; more moving parts for little value.

**5. Required-property gaps are acknowledged in the request, not just warned about.** The server computes the version's unbound required properties from the current schema and requires the request to list them, so a client cannot activate without having been shown them. Names listed that are not unbound required properties are rejected, which keeps the stored acknowledgment honest. The markers for those properties stay open, so the site keeps showing as needing attention. Alternatives: block activation (a stubborn site could never go live); allow silently (the gap would only appear in the markers).

**6. Markers are cleared by property, in the same transaction.** Only `property_pending` markers for properties the version binds are cleared; markers for unbound properties and other reasons stay. A property added to the schema after the version was authored remains pending, because the version does not bind it.

**7. Schedule is created after the transaction from the stored cadence, idempotently, and reconciled.** EventBridge Scheduler is outside PostgreSQL, so the first activation commits the pointer and then upserts the site's schedule (create-or-update by a deterministic name). If that call fails, a periodic reconciler creates schedules for sites that have an active pointer and no schedule. The first scrape is requested through the normal refresh path, so it is deduplicated like any other. Alternative: outbox table processed by a worker; heavier than a periodic reconciliation for one external call.

**8. Cadence is the customer's choice per site, stored in `site_schedules`, with an operator floor.** There is no default: a first activation without a cadence is rejected, so the customer always decides how often their site is scraped. The cadence (cron or rate expression, optional IANA timezone, UTC if omitted) is the source of truth in PostgreSQL and the EventBridge schedule mirrors it, which is also what lets the reconciler rebuild a lost schedule. A configured minimum interval (one hour by default) bounds the cost of a POC where prospects choose frequencies; it is checked by sampling the next few firing times of the expression. Changing the cadence updates the row and upserts that site's schedule only, requests no scrape and does not touch a run in progress. Alternatives: a configured default (silently decides cost for the customer); a fixed menu of presets (simpler UI, but cron/rate expressions cost nothing extra and the frontend can still offer presets).

**9. Retry has two distinct paths and the review keeps them apart.** Guidance is stored on a new discovery attempt and affects only that site. A property description edit is the persistence change's schema operation: it creates a new schema version for the whole catalog, so it is offered as an explicit separate action and never performed as a side effect of retrying. Retrying never modifies or discards the reviewed candidate. For gaps in a candidate, retry can run `incremental` with the candidate as base, so working bindings are not re-derived.

**10. Discard is a flag on the version record, not a deletion.** Versions are immutable and referenced by attempts, previews and history; discarding only blocks activation and hides the candidate from "ready" lists. The active version cannot be discarded.

**11. The review is assembled on read from existing records.** It joins the version record, preview run, evidence bundle references, the schema's unbound properties and the active pointer; nothing new is stored for it. Evidence and preview results stay in S3 under the owner prefix and are returned as references. Alternative: materialize a review document at storing time; it would go stale when the schema or active version changes.

**12. Customer scoping is a query condition now, authentication later.** Every read and write resolves the site through its customer; a site of another customer is "not found". When accounts arrive, the customer comes from the login instead of the request.

## Risks / Trade-offs

- [Two sources of truth if `active.json` is left in place] → remove it in the same change that introduces the pointer; one migration step seeds pointer rows from existing `active.json` objects for the dev customer.
- [Depends on the scrape change's per-version preview dedupe] → that change is amended; a task here verifies the behavior end to end.
- [Schedule drift between the database and EventBridge] → idempotent upsert plus a periodic reconciler that also removes schedules for sites without a pointer.
- [Customers activate a bad spec anyway] → mitigated by preview, evidence, the next scrape's completeness gate, and rollback being a single action.
- [Preview sample is small and may not show a broken minority of items] → the discovery verification already checks parse rates over a larger sample; the first production run after activation is gated by the completeness checks before it can change data.
- [Retrying many times costs money] → every retry is a discovery attempt subject to caps and the later budget hook.
- [Customers choose very frequent cadences] → the minimum interval, the completeness gate, and later budgets; scrape concurrency is already capped.
- [Ack lists can be pasted blindly by a client] → the server computes the required set, so a client has to fetch it from the review first; the stored acknowledgment is still evidence of what was shown, not proof a person read it.

## Migration Plan

Nothing is deployed. Order: tables and pointer implementation behind the existing port; activation service and history; review assembly; preview-on-ready hook and the preview dedupe adjustment; first-activation schedule and reconciler; retirement of `active.json`; end-to-end checks. Rollback: re-activate the previous version; the schedule reconciler can be disabled without affecting pointers.

## Open Questions

- Whether the reconciler runs on a timer or on startup plus daily, and the final minimum-interval default.
- How many days a discarded or never-activated candidate is retained before cleanup, if ever.
