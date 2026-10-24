# Scrape execution

Scheduled, on-demand and preview scrapes all follow one path: the API records a run in `scrape_runs`, sends one message to an SQS FIFO queue, and a stateless worker (Lambda container image; the same image can run on Fargate) executes the site's **selector spec** with Puppeteer. The worker has no database access and no LLM. It writes the full result to object storage and sends a small *finished* message to a results queue, which the API consumes to decide whether the run is complete.

```
refresh / preview endpoint ─┐
EventBridge Scheduler ──────┴─> scrape_runs row + SQS FIFO ──> worker ──> S3 result
                                                                  │
                         API: run finalizer <── results queue <───┘
                              ├─ complete production run ─> reconciliation (typed values only)
                              └─ failure ─> run record (+ failed_scrape for production)
```

## Selector spec

A declarative JSON document, validated against a closed vocabulary (`src/scrape/spec/`). Nothing in it is executed as code; unknown fields, step types, transforms or pagination modes make it `invalid_spec`.

- `formatVersion` (currently `1`), `site.url`
- `steps`: `open_url`, `click`, `wait_for`, `scroll`
- `pagination` (optional, always bounded by `maxPages`): `next_button`, `url_template` (with `{page}`), `infinite_scroll`
- `items.locator` and bindings for the system fields `name`, `link`, `price`, `thumbnail_url` and for each extracted schema property (`properties`). A locator is `{css}` or `{xpath}`; the source is `"text"` or `{attribute}`. Locators are relative to the item.
- `variants` (when the schema has a variant property): a locator for the options plus `value`, `price` and `available` bindings. `available` without transforms means "the source is present".
- `transforms` per binding, applied in order: `trim`, `regex`, `number` (locale), `date` (format and locale, producing `YYYY-MM-DD`; quote literal text in the format, for example `dd 'de' MMMM yyyy`), `enum_map`, `boolean_map`, `split`.

Spec versions are immutable objects at `customers/{customerId}/sites/{siteId}/specs/{version}.json`. Storing a version again with different content is rejected. Until the activation change owns the pointer, the active version is the number in `customers/{customerId}/sites/{siteId}/specs/active.json` (`{"version": 3}`).

## Scrape message

```json
{
  "runId": "5c7a0d52-3c4e-4d1a-9a0b-0e6c7f1b2a11",
  "mode": "preview",
  "customerId": "00000000-0000-4000-8000-000000000001",
  "catalogId": "3f0f6e55-9e55-4c33-8f1d-2b8d3c0d9a10",
  "siteId": "a1d4a8e2-6a1c-4f43-b9a0-52b6e4f7c001",
  "specKey": "customers/00000000-0000-4000-8000-000000000001/sites/a1d4a8e2-6a1c-4f43-b9a0-52b6e4f7c001/specs/3.json",
  "specVersion": 3,
  "schemaVersion": 2,
  "schema": { "properties": ["gender", "type", "size", "unit_system"], "variantProperty": "size" },
  "limits": { "maxPages": 2, "maxItems": 20 }
}
```

`limits` is present on previews only. `schema` is the pinned schema's shape, so the worker can check the spec without database access. FIFO: `MessageGroupId` is the site id; the deduplication id is `{siteId}:production` or `{siteId}:preview:{specVersion}`.

## Finished message

```json
{ "runId": "5c7a0d52-3c4e-4d1a-9a0b-0e6c7f1b2a11", "outcome": "succeeded",
  "resultKey": "customers/…/catalogs/…/sites/…/runs/5c7a…/result.json",
  "stats": { "items": 18, "pages": 2, "durationMs": 41230 } }
```

`outcome` is `started` (sent when the worker picks the run up), `succeeded` or `failed` (with `reason`). Results always travel by reference.

## Run states and failure reasons

`queued` → `running` → `succeeded` | `failed`. At most one pending production run per site and one pending preview per site and spec version (partial unique indexes); a duplicate request is answered with the existing run.

| Reason | Meaning | Retried |
| --- | --- | --- |
| `no_spec` | the spec version does not exist | no |
| `invalid_spec` | the spec fails validation (the browser is never opened) | no |
| `schema_mismatch` | the spec binds a property the pinned schema lacks | no |
| `timeout` | the run hit its time limit; the partial result is stored but never reconciled | no |
| `count_anomaly` | item count deviates from the previous complete run by more than 30% | no |
| `parse_anomaly` | a property parsed for less than 80% of its present raw values | no |
| `stale_schema` | the catalog's schema version changed while the run was in progress | no |
| `error` | unexpected failure (browser crash, network) after the queue gave up | yes, 3 receives, then the dead-letter queue |

Thresholds are configuration (`CompletenessConfig`). A first run for a site skips the count check.

## Completeness and reconciliation

Only a **production** run that finished in time, was not stale, and passed the count and parse checks is handed to reconciliation, and only its typed `value`s (never raw text). Failed production runs publish `failed_scrape` with the reason; previews never reconcile and never publish.

## Result layout

`customers/{customerId}/catalogs/{catalogId}/sites/{siteId}/runs/{runId}/result.json`, expiring after 30 days:

```json
{ "runId": "…", "mode": "production", "finished": true, "pages": 2, "skipped": 0,
  "items": [ { "raw": { "name": "Remera 1", "launch": "15/10/2026" },
               "value": { "name": "Remera 1", "launch": "2026-10-15" },
               "issues": [], "variants": [] } ] }
```

A value that fails its transforms is absent from `value` and appears in `issues` with the raw text. Items without a name or link are dropped and counted in `skipped`.
