# Tasks

## 1. Pointer, history and review records

- [x] 1.1 Add the migration for `site_active_specs` (one row per site, version, activated time) and `site_activations` (site, version, replaced version, preview run, acknowledged properties, approver nullable, time), `site_schedules` (site, expression, timezone, updated time), and a `discarded_at` column on `site_spec_versions`; verify integration tests that a second pointer row for a site is refused and history rows cascade with the site
- [x] 1.2 Implement the database active-spec resolution behind the scrape change's port, with `no_spec` when there is no pointer; verify tests for no pointer, a pointer, and a run keeping the version it was requested with after a later activation
- [x] 1.3 Confirm the scrape change's preview deduplication by site and spec version is in place (partial unique index and FIFO dedup id); verify a test that storing version 4 while version 3's preview runs creates a separate preview run for version 4, and that repeated requests for the same version collapse

## 2. Activation service

- [x] 2.1 Implement the activation transaction with the compare-and-set on the replaced version (`stale_activation`), the idempotent repeat of the already-active version, and a first activation that names no current version; verify integration tests including two concurrent activations where exactly one succeeds
- [x] 2.2 Implement the preconditions (version belongs to the site, not discarded, succeeded preview run of that exact version or previously active, every bound property still in the current schema); verify tests for `preview_required`, discarded, previously active, `schema_changed` and another site's version
- [x] 2.3 Implement the required-property acknowledgment (server-computed unbound required set, `422` listing missing names, rejection of names that are not unbound required properties, acknowledgment stored on the history row); verify tests for each scenario in the spec including an optional property needing none
- [x] 2.4 Clear `property_pending` markers in the same transaction for the properties the version binds only; verify tests for partial clearing, other marker reasons untouched, and nothing cleared when the transaction fails
- [x] 2.5 Implement rollback through the same endpoint and the discard operation (active version cannot be discarded, discarded versions cannot be activated); verify integration tests for a rollback with history and for both discard cases
- [x] 2.6 Expose `POST /internal/sites/{siteId}/activations`, `GET .../activations` (newest first) and the discard endpoint, all scoped to the owning customer; verify e2e tests for each status code and for another customer getting "not found"

## 3. Schedule and first scrape

- [x] 3.1 Implement cadence validation (cron or rate expression, optional IANA timezone, minimum interval by sampling upcoming firing times) and, for a first activation, require it (`422 cadence_required`), store it in `site_schedules`, upsert the site's schedule by deterministic name and request one production scrape through the normal refresh path; verify tests for a missing, invalid and too-frequent cadence, that replacement activations change neither schedule nor runs, and that a repeated first activation does not duplicate the schedule or the run
- [x] 3.2 Implement the schedule reconciler (create or correct schedules from `site_schedules` for sites with a pointer, remove schedules for sites without one) and call it on a timer; verify a test where schedule creation fails during activation and the reconciler repairs it from the stored cadence
- [x] 3.3 Expose `PUT /internal/sites/{siteId}/schedule` and `GET` to change and read a site's cadence (`409 no_active_spec`, `422`, another customer's site "not found"); verify e2e tests that a change updates only that site's stored cadence and schedule, requests no scrape and leaves a run in progress alone

## 4. Preview and review

- [x] 4.1 Add the hook on the discovery finalizer that enqueues a preview of the stored version, and the endpoint to request a new preview of a version whose preview failed or expired; verify tests that storing a version creates exactly one preview and that a failed preview can be re-requested
- [x] 4.2 Implement review assembly (`GET /internal/sites/{siteId}/spec-versions/{version}/review`): version record, preview status and sample references, evidence references, unbound properties with required flags, the active version and the ready-to-activate state; verify tests for pending, failed and succeeded previews, an expired result, and another customer's version
- [x] 4.3 Implement retry from a review (new discovery attempt with new guidance, optionally `incremental` with the reviewed version as base) without touching the reviewed candidate or the schema; verify tests that the earlier version stays reviewable and the property description is unchanged

## 5. Retire the interim pointer and integrate

- [x] 5.1 Remove the `active.json` reads and writes, add a one-off seeding step that creates pointer rows from existing `active.json` objects for the dev customer, and update the scrape tests that relied on it; verify the full test suite passes with no `active.json` references remaining
- [x] 5.2 End-to-end: discover a candidate for a dev site, see the automatic preview, activate with an acknowledged unbound required property, and verify the pointer, the cleared and remaining markers, the schedule, and the first production run; verify the history row
- [x] 5.3 End-to-end: activate version 3 over version 2, then roll back to version 2, and verify runs requested after each step use the expected version and history lists both newest first
- [x] 5.4 Update `docs/` to describe the customer flow (candidate, preview, activation, retry paths, rollback) and the two retry paths; verify the document matches the endpoints and states
