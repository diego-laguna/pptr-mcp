# Catalog Scraper — Requirements

Sep 27, 2026 · drafted by @Diego

## Overview

This tool lets Claude analyze a target e-commerce site once, driving a real browser, to locate the XPath/CSS selectors and click/navigation sequence needed to reach and extract catalog data. It then writes that logic into a standalone script. That script is later re-run on its own — no AI involved — to refresh the catalog on a schedule.

Goals:

- One AI-assisted discovery pass per site (run once, or re-run on demand if the site's markup changes) that produces a deterministic, site-specific extraction script.
- Deterministic script execution for recurring updates, with no LLM calls, no MCP, and no added latency or cost.
- One consistent JSON shape across all target sites, so downstream consumers don't need per-site logic.

## Target Sites

Each site gets its own generated extraction script — page structures differ enough that selectors won't transfer between sites.

| # | Site | URL |
| --- | --- | --- |
| 1 | Grisino | https://www.grisino.com/ |
| 2 | Cheeky | https://www.cheeky.com.ar/ |
| 3 | Naranjo | https://www.naranjo.com.ar/ |
| 4 | Mimo | https://www.mimo.com.ar/ |
| 5 | Baby Cottons | https://www.babycottons.com.ar/ |

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
  "gender": "string (e.g. \"girls\", \"boys\", \"unisex\")",
  "size": "string (e.g. \"10\", \"S\", \"3-6m\")",
  "type": "string (e.g. \"t-shirt\", \"pants\", \"dress\")",
  "updated": "string (ISO 8601 timestamp)"
}
```

- `price` stays a string, as displayed on the site (currency symbol, formatting) — normalization is a later concern.
- Envelope `updated` is when this scrape run completed; item `updated` is when that item was last confirmed present, so staleness can be tracked per item across runs.
- `gender`, `size`, and `type` aren't always on the catalog/listing page — a site's script may need to read them from the breadcrumb/category path, the product detail page, or the item name. A field the script can't determine with confidence is left out rather than guessed.
- A product offered in multiple sizes becomes multiple catalog entries — same `name`/`link`/`thumbnail_url`/`gender`/`type`, one entry per `size` (with that size's own `price`), matching the `products` + `product_sizes` split in Persistence Layer.

## Persistence Layer

PostgreSQL, confirmed. Schema splits identity from pricing so sizes are tracked independently of the product itself:

- `products` — one row per catalog item as identified by the site (e.g. by `link`): `id`, `site_id`, `name`, `link`, `thumbnail_url`, `gender`, `type`, `updated`. Deleted outright once a scrape no longer finds it — no history kept at the product level. Indexes on `gender`, `type`, `site_id`, and a text-search index on `name`.
- `product_sizes` — one row per size a product is offered in: `id`, `product_id` (FK → `products.id`, `ON DELETE CASCADE`), `size`, `price`, `available` (boolean), `updated`. A size not found in a scrape is kept and flipped to `available = false` rather than deleted, so the frontend can show it as out of stock. Index on `(product_id, size)`, and on `size` alone for filtering across products.

A query like "t-shirts for girls, size 10" filters `products` on `gender`/`type` and joins `product_sizes` on `size`.

Each refresh reconciles against what's stored, rather than overwriting it, at both levels:

- New product in the scrape, not in the store → insert into `products`, with its sizes into `product_sizes` (`available = true`).
- Stored product missing from the new scrape → delete the `products` row (cascades to its `product_sizes` rows) — nothing kept.
- Product present in both, but a size no longer offered → keep the `product_sizes` row and set `available = false`, rather than deleting it.
- A size present in both → update its `price` and `updated`, and set `available = true` if it had been marked unavailable.

That reconciliation is what lets the query endpoint and the frontend show a size as out of stock instead of silently hiding it, and still gives per-size price history for as long as the product itself is listed.

## Frontend Requirements

- Site selection (optional): scope results to one target site, or search across all of them.
- Filter/search: narrow the catalog by `gender`, `size`, and `type` (e.g. "t-shirts for girls, size 10"), or by free-text name.
- Availability: a size that's out of stock still shows (e.g. grayed out / labeled "not available") instead of disappearing from the results.
- Catalog retrieval: request the latest stored catalog, filtered or not.
- Download: download the returned catalog array as a JSON file.

## Backend API Requirements

| # | Endpoint | Audience | Purpose |
| --- | --- | --- | --- |
| 1 | `GET /api/sites` | User-facing | List the available target sites (id, name, URL) |
| 2 | `GET /api/catalog` | User-facing | Query the stored catalog, filtered by `siteId`, `gender`, `size`, `type`, and/or free-text `q`; omitting `siteId` searches across all sites. Each result includes whether that size is currently available. |
| 3 | `POST /internal/sites/{siteId}/refresh` | Internal only | Re-run that site's generated (non-AI) script and reconcile the persisted catalog; called by the scheduler app |

The internal endpoint isn't exposed to end users — it needs its own access control (e.g. network restriction or a service credential), separate from the user-facing endpoints. A cross-site result from the query endpoint includes which site each item came from (its stored `site_id`), since a filtered query can span every target site.

## Architecture

**Discovery (AI, once per site) → Execution (scheduled, no AI), with a failure loop:**

```
Claude Agent SDK
      ↓
Puppeteer MCP (browser control)
      ↓
Target site (live DOM)
      ↓
Generated script (selectors + click/pagination steps)   ← capped re-discovery ──┐
      ↓                                                                         │
Scheduler (cron) → Internal endpoint ─┐                                         │
                                       ↓                                        │
                              Run script (Puppeteer only, no AI) ── failed_scrape → SQS queue
                                       ↓
                                Catalog store
                                       ↓
                            User-facing endpoints
                       (list sites · get catalog · download)
```

Discovery (top) runs once per site, or again later if a script starts failing: Claude, via the Agent SDK, drives a real browser through the Puppeteer MCP server to load the target site, locate the catalog listing, and work out the selectors and navigation/click sequence needed to reach every item. That analysis is written out as a standalone script and saved to the repo (one script per site).

Execution (bottom) is what the scheduler triggers on a recurring basis: it calls the internal refresh endpoint, which runs that site's generated script directly with Puppeteer — no MCP, no LLM call — maps the results into the catalog JSON shape, and persists them. If that run fails, it publishes a `failed_scrape` event to an SQS queue; a discovery service consumes it with up to 2 concurrent workers, retrying transient failures, with a redrive policy (`maxReceiveCount: 3`) routing a selector that keeps failing to a dead-letter queue instead of re-running discovery on every scrape. The user-facing endpoints then serve whatever was last persisted.

## Open Items / Next Steps

- [ ] Decide how `gender`/`size`/`type` are derived per site (breadcrumb, product detail page, or name parsing) — likely custom per site
- [ ] Free-text search strategy across sites (Spanish text: accents, plurals, synonyms like "remera" / "camiseta" / "t-shirt")
- [ ] Scheduler cadence per site (fixed interval vs. per-site config)
- [ ] Access control for the internal refresh endpoint

---

Source: [Catalog Scraper — Requirements](https://claude.ai/code/artifact/527233dc-166c-4d32-9985-19dab284a779) (Claude Docs, live doc with the rendered architecture diagram)
