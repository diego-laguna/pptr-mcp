# Candidates, activation and cadence

Discovery ([discovery.md](discovery.md)) stores immutable **candidate** versions. Nothing runs in production until a customer **activates** one. Until accounts exist, every endpoint below is internal (`Authorization: Bearer <INTERNAL_API_TOKEN>`) and carries the owning customer in an `X-Customer-Id` header; a site of another customer is always "not found".

## The flow

1. **Discover.** `POST /internal/sites/{siteId}/discoveries` stores version N. Storing a version automatically enqueues a **preview** of exactly that version (previews are deduplicated per site and version, so version 4 is never answered with version 3's run).
2. **Review.** `GET /internal/sites/{siteId}/spec-versions/{version}/review` returns the version record, the preview status (`none`, `pending`, `failed`, `succeeded`; `expired` when the stored sample aged out), up to 10 sample items with raw next to typed values, the discovery evidence (annotated screenshot references, parse rates, stability warnings, unresolved properties, old-versus-new bindings for a repair), the schema properties the version leaves unbound with their required flags, the active version, and `readyToActivate`. `GET .../spec-versions` lists all versions (newest first, discarded ones marked) with the active version.
3. **Activate.** `POST /internal/sites/{siteId}/activations` with `{ "version", "expectedCurrent", "acknowledge"?, "cadence"?, "approvedBy"? }`.
4. **Roll back** by activating an older version through the same request.
5. **Retry or discard** a candidate (below).

## Activation

One transaction, serialized per site, moves the pointer (`site_active_specs`), clears markers and writes the history row (`site_activations`).

| Check | Failure |
| --- | --- |
| the version exists for the site | `404` |
| `expectedCurrent` is the version active now (`null` for a first activation) | `409 stale_activation` |
| the version was not discarded | `409 discarded` |
| a succeeded preview of that exact version exists, or the version was active before (rollback) | `409 preview_required` |
| every property the version binds is still in the current schema | `409 schema_changed` |
| every required property the version leaves unbound is listed in `acknowledge` (and nothing else is) | `422 unacknowledged_properties` / `invalid_acknowledgment`, with `properties` |
| first activation only: a valid `cadence` | `422 cadence_required` / `invalid_cadence` |

Activating the version that is already active succeeds without a new record (`changed: false`). `property_pending` markers are cleared only for properties the version binds; markers for unbound properties (including acknowledged required ones) and other reasons stay. `GET .../activations` lists the history newest first, with the preview run relied on, the acknowledged properties and the approver (empty until accounts exist).

## Cadence

The customer chooses how often **their** site is scraped: a first activation must carry `cadence: { "expression": "rate(1 day)" | "cron(0 8 * * ? *)", "timezone"?: "America/Argentina/Buenos_Aires" }` (UTC when omitted). There is no default. The expression must parse and fire no more often than the operator's minimum interval (`SCHEDULE_MIN_INTERVAL_MINUTES`, 60 by default; cron expressions are checked by sampling their next firing times, evaluated in UTC; `L`, `W` and `#` are not supported).

The cadence is stored in `site_schedules` (the source of truth) and mirrored as one EventBridge schedule per site. After the first activation commits, the schedule is created and one production scrape is requested through the normal refresh path. If the schedule cannot be created at that moment the activation stands and a reconciler (`SCHEDULE_RECONCILE_MINUTES`, default 15, runs when `SCRAPE_CONSUMERS=true`) creates or corrects schedules from the stored cadences and removes schedules of sites with no active version. Replacement activations and rollbacks never touch the schedule or request a scrape; a running scrape keeps the version it was enqueued with.

`PUT /internal/sites/{siteId}/schedule` changes the cadence at any time while the site has an active version (`409 no_active_spec` otherwise, `422` for an invalid or too-frequent cadence); it updates only that site's cadence and schedule, requests no scrape and does not affect a run in progress. `GET` reads it.

## Two ways to retry

- **Guidance for this site** (the default): `POST .../spec-versions/{version}/retry` with `{ "guidance": "...", "mode"?: "full" | "incremental" }` queues a new discovery attempt for the site. `incremental` extends the reviewed version (`baseVersion`) with bindings for the properties it left unbound, so working bindings are not re-derived. The reviewed candidate and the schema are not touched.
- **Edit the property description**: a catalog-wide schema operation (`SchemaChangeService`, `edit_property`) that benefits every site of the catalog. It is a separate, explicit action and is never done as a side effect of a retry.

`POST .../spec-versions/{version}/previews` requests a fresh preview of a version whose preview failed or whose sample expired. `POST .../spec-versions/{version}/discard` marks a version discarded (it stays stored and listed, and cannot be activated); the active version cannot be discarded (`409`).

## Moving from `active.json`

The interim `active.json` object is no longer read. `seedPointersFromActiveJson` (`src/activation/seed-active-pointers.ts`) creates pointer rows from any such objects once, leaving existing rows alone.
