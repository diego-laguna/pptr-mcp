# Catalog Scraper — Requirements

Sep 27, 2026 · drafted by @Diego

## Overview

This tool lets Claude analyze a target e-commerce site once, driving a real browser, to locate the XPath/CSS selectors and click/navigation sequence needed to reach and extract catalog data. It then writes that logic into a standalone script. That script is later re-run on its own — no AI involved — to refresh the catalog on a schedule.

Goals:

- One AI-assisted discovery pass per site (run once, or re-run on demand if the site's markup changes) that produces a deterministic, site-specific extraction script.
- Deterministic script execution for recurring updates, with no LLM calls, no MCP, and no added latency or cost.
- One consistent JSON shape across all target sites, so downstream consumers don't need per-site logic.

## Target Sites

Each site gets its own generated extraction script — page structures differ enough that selectors won't transfer between sites. Each site is scraped under its catalog's schema (see Persistence Layer), which defines which product attributes it collects; the five below are the first development customer's clothing/footwear catalog, in Argentina, priced in ARS.

| # | Site | URL | Country | Currency |
| --- | --- | --- | --- | --- |
| 1 | Grisino | https://www.grisino.com/ | AR | ARS |
| 2 | Cheeky | https://www.cheeky.com.ar/ | AR | ARS |
| 3 | Naranjo | https://www.naranjo.com.ar/ | AR | ARS |
| 4 | Mimo | https://www.mimo.com.ar/ | AR | ARS |
| 5 | Baby Cottons | https://www.babycottons.com.ar/ | AR | ARS |

## Output Data Model

Every site's script returns the same envelope:

```json
{
  "target_url": "string",
  "updated": "string (ISO 8601 timestamp)",
  "catalog": []
}
```

Each catalog entry:

```json
{
  "name": "string",
  "link": "string (absolute URL)",
  "price": "string",
  "thumbnail_url": "string (absolute URL)",
  "attributes": "object — per the catalog's schema, see Persistence Layer",
  "updated": "string (ISO 8601 timestamp)"
}
```

- `price` stays a string, as displayed on the site (currency symbol, formatting) — normalization is a later concern.
- Envelope `updated` is when this scrape run completed; item `updated` is when that item was last confirmed present, so staleness can be tracked per item across runs.
- `attributes` holds whatever properties the catalog's schema defines (see Persistence Layer) — a clothing catalog might define `gender`, `size`, `type`, `unit_system`; a cosmetics catalog `color`, `ingredients`; a car-parts catalog `type`, `manufacturer`, `warranty_duration`. A field the script can't determine with confidence is left out rather than guessed.
- A product with multiple variants (e.g. several clothing sizes) becomes multiple catalog entries — same `name`/`link`/`thumbnail_url` and non-variant attributes, one entry per variant value (with that variant's own `price`), matching the `products` + `product_variants` split in Persistence Layer.

## Persistence Layer

PostgreSQL (RDS on AWS), accessed with `pg` and plain SQL migrations (`node-pg-migrate`, no ORM). Full detail, including the schema-change operations and how to run migrations and the dev seed, is in [persistence.md](persistence.md). The service is multi-tenant: customers are external, each owns many private catalogs, and every read and write is scoped to a customer.

- `customers` — `id`, `name`. Identity and logins arrive with the accounts work.
- `catalogs` — one per customer's catalog: `id`, `customer_id`, `name` (unique per customer), `schema_version` (the current version).
- `catalog_schema_versions` — the catalog's schema, one immutable row per version: `properties` (JSONB list of typed, described properties), `variant_property` (which property, if any, splits a product into separately priced rows — `size` for clothing, none for car parts), and `changes` (the operations that produced the version). Property types: string, number, boolean, url, date (ISO `YYYY-MM-DD`), enum, string list; at most 50 properties.
- `sites` — belong to a catalog and are scraped under its schema: `id`, `catalog_id`, `url` (unique per catalog), `name`, `country` (ISO 3166-1 alpha-2), `currency` (ISO 4217).
- `site_attention` — markers telling a customer a site needs follow-up (for example `property_pending` after a property is added); cleared markers are kept as history.
- `products` — one row per catalog item as identified by the site (by `link`): `id`, `site_id`, `name`, `link`, `thumbnail_url`, `attributes` (JSONB, the schema's non-variant properties), `updated_at`, plus `price`/`available` directly on this row when the schema has no variant property. Deleted outright once a scrape no longer finds it. Indexes: GIN on `attributes`, text search on `name`, and `(site_id, link)` unique.
- `product_variants` — one row per variant value when the schema has a variant property: `id`, `product_id` (FK → `products.id`, `ON DELETE CASCADE`), `variant_value`, `price`, `available`, `updated_at`; unique on `(product_id, variant_value)`. A variant not found in a scrape is kept and flipped to `available = false` rather than deleted.

The customer defines the schema; it is not chosen from a fixed list of templates. Schemas evolve through explicit operations (add, rename, remove, edit a description, add or remove an enum value). Adding a property creates a new version and marks the catalog's sites `property_pending` so a follow-up discovery can find it; renaming or removing a property migrates stored attributes with no discovery; changing a property's type is rejected (remove and add instead). Product writes declare the schema version they were produced under and are rejected as stale if the catalog has moved on.

Values are stored in canonical typed form; converting site text (for example a date shown as `15/10/2026`) happens upstream in the scrape run, whose raw and typed values are kept in object storage rather than in PostgreSQL. `price` stays text, exactly as shown on the site.

A query like "t-shirts for girls, size 10" filters `products` on `attributes @> '{"gender":"girls","type":"t-shirt"}'` and joins `product_variants` on `variant_value = '10'`; a car-parts catalog without a variant property only touches `products.attributes`.

Each refresh reconciles against what's stored, rather than overwriting it, at both levels:

- New product in the scrape, not in the store → insert into `products` (with `attributes`, and `price`/`available` if the schema has no variant property), with any variants into `product_variants` (`available = true`).
- Stored product missing from the new scrape → delete the `products` row (cascades to its `product_variants` rows) — nothing kept.
- Product present in both, but a variant no longer offered → keep the `product_variants` row and set `available = false`, rather than deleting it.
- A variant present in both → update its `price` and `updated_at`, and set `available = true` if it had been marked unavailable.

That reconciliation is what lets the query endpoint and the frontend show a variant as out of stock instead of silently hiding it, and still gives per-variant price history for as long as the product itself is listed.

## Frontend Requirements

- Site selection (optional): scope results to one target site, or search across all of them.
- Filter/search: narrow the catalog by the properties the selected catalog's schema marks filterable (e.g. `gender`/`size`/`type` for clothing, `color`/`ingredients` for cosmetics), or by free-text name.
- Availability: a variant that's out of stock still shows (e.g. grayed out / labeled "not available") instead of disappearing from the results.
- Catalog retrieval: request the latest stored catalog, filtered or not.
- Download: download the returned catalog array as a JSON file.

## Backend API Requirements

All data is scoped to a customer: a request only ever sees that customer's catalogs, sites and products, and another customer's ids behave as if they do not exist. Authentication and the customer-facing scoping rules arrive with the accounts work.

| # | Endpoint | Audience | Purpose |
| --- | --- | --- | --- |
| 1 | `GET /api/sites` | User-facing | List the customer's sites for a catalog (id, name, URL, country, currency) |
| 2 | `GET /api/catalog` | User-facing | Query the stored products of one of the customer's catalogs, filtered by `siteId`, free-text `q`, and the catalog schema's properties (e.g. `gender`/`size`/`type` for clothing); omitting `siteId` searches across all of that catalog's sites. Each result includes whether that variant is currently available. |
| 3 | `POST /internal/sites/{siteId}/refresh` | Internal only | Enqueue a scrape of the site's active selector spec and answer `202` with a `runId`; the queued, non-AI run reconciles the persisted catalog only if it is complete. A sibling `POST /internal/sites/{siteId}/preview` runs a candidate spec without persisting. See [scrape-execution.md](scrape-execution.md) |

The internal endpoint isn't exposed to end users — it needs its own access control (e.g. network restriction or a service credential), separate from the user-facing endpoints. A cross-site result from the query endpoint includes which site each item came from (its stored `site_id`), since a filtered query can span every site of a catalog.

## Architecture

**Discovery (AI, on request) → Execution (scheduled, no AI), with a failure event:**

```
Discovery request (full · incremental · repair) → SQS → Claude Agent SDK worker
      ↓                                                  (closed tool set, guarded browser)
Target site (live DOM)
      ↓
Candidate selector spec, verified against the live site by the production runner
      ↓
Immutable spec version in S3 + evidence (samples, parse rates, annotated screenshots)
      ↓  (customer previews and activates — a later change)
Scheduler (per-site schedule) / internal endpoint → SQS → Scrape worker (no AI) ── failed_scrape → SQS queue
                                                              ↓
                                                    Complete runs only → Catalog store
                                                              ↓
                                                    User-facing endpoints
                                       (list sites · get catalog · download)
```

Discovery (top) runs only when requested — the first time for a site, to add properties the schema gained (`incremental`), or to repair bindings after a site redesign (`repair`). Claude, via the Agent SDK, drives a guarded browser to load the target site, locate the catalog listing, and work out the selectors and navigation needed to reach every item and the schema's properties. Its only output is a declarative selector spec submitted through a validating tool; the spec is run against the live site with the same runner used in production and offered only if it passes (item count, system-field coverage, distinct links, parse rates). A passing spec is stored as a new immutable version and is never activated automatically. See [discovery.md](discovery.md).

Execution (bottom) is what the scheduler triggers on a recurring basis: its per-site schedule (or the internal refresh endpoint) enqueues a scrape on an SQS FIFO queue; a stateless worker runs that site's declarative selector spec with Puppeteer — no MCP, no LLM call — and stores raw and typed values, and the API reconciles the persisted catalog only when the run is complete (see [scrape-execution.md](scrape-execution.md)). If a production run fails, it publishes a `failed_scrape` event to an SQS queue for later consumers; transient failures are redelivered, with a redrive policy (`maxReceiveCount: 3`) routing a request that keeps failing to a dead-letter queue. The user-facing endpoints then serve whatever was last persisted.

## Open Items / Next Steps

- [ ] Decide how each schema property is derived per site (breadcrumb, product detail page, or name parsing) — likely custom per site
- [ ] Free-text search strategy across sites (language follows a site's country — not just Spanish/English)
- [ ] Cross-country comparability: a clothing query spanning countries mixes sizing systems unless scoped by `unit_system` or country
- [ ] Scheduler cadence per site (fixed interval vs. per-site config)
- [ ] Access control for the internal refresh endpoint

---

Source: [Catalog Scraper — Requirements](https://claude.ai/code/artifact/527233dc-166c-4d32-9985-19dab284a779) (Claude Docs, live doc with the rendered architecture diagram)
