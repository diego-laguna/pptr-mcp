# Design

## Context

See proposal.md. Current state: bare Nest 12 (Fastify) scaffold, ESM, Vitest, pnpm, no database code. docs/TECH_STACK.md fixes PostgreSQL; the deployment target is AWS (RDS PostgreSQL). Decisions from exploration: customers are external; each owns many private catalogs; the schema is customer-authored per catalog; selector specs are per site (a later change); additive changes need a follow-up discovery, rename and remove do not.

## Goals / Non-Goals

**Goals:**
- A tenant-aware model that later changes (accounts, reconciliation, scraping, discovery, API) can build on without reshaping tables.
- Schema evolution that keeps stored data consistent and is safe under concurrent scrapes.
- Integration tests against a real PostgreSQL, since JSONB containment and GIN indexes are central.

**Non-Goals:**
- Authentication and user management (`add-accounts-and-ownership`).
- Selector spec storage and the deterministic rewrite of specs after rename/remove; this change only records the operations so that rewrite can replay them.
- Reconcile logic, query endpoints, discovery, budgets.

## Decisions

**1. Plain SQL migrations with `node-pg-migrate`, data access through `pg`; no ORM yet.** Unchanged from the first draft. The model leans on JSONB `@>`, GIN and text-search indexes, and on transactional JSONB rewrites that ORMs express awkwardly. Alternatives: Prisma, TypeORM/MikroORM, Kysely. Revisit if query code grows.

**2. Table layout.**

```
customers(id, name, created_at)
catalogs(id, customer_id FK, name, schema_version, created_at)   unique(customer_id, name)
catalog_schema_versions(catalog_id FK, version, properties JSONB,
                        variant_property, changes JSONB, created_at)   pk(catalog_id, version)
sites(id, catalog_id FK, url, name, country, currency, created_at)     unique(catalog_id, url)
site_attention(id, site_id FK, reason, property, created_at, cleared_at)
products(id, site_id FK, name, link, thumbnail_url, attributes JSONB,
         price, available, updated_at)                                  unique(site_id, link)
product_variants(id, product_id FK ON DELETE CASCADE, variant_value,
                 price, available, updated_at)                          unique(product_id, variant_value)
```

`catalogs.schema_version` points at the current row of `catalog_schema_versions`. Deleting a site cascades to its products and attention rows. This replaces the PRD's `metadata_templates`; the PRD is updated by a task.

**3. Schema stored as a JSONB array of property definitions** (`name`, `type`, `description`, `required`, `filterable`, optional `example`, enum `values`) inside each version row, validated by one schema validator used by catalog creation, schema changes and product writes. Alternative: a `properties` table; stricter at the DB level, but versions would need copying and the validator is needed anyway.

**4. Schema changes are explicit operations, never a diff.** The input is a list such as `add_property`, `rename_property{from,to}`, `remove_property`, `edit_property` (description, example, filterable), `add_enum_value`, `remove_enum_value`. A rename cannot be told apart from remove-plus-add by diffing two schemas, and getting that wrong would silently drop data. The operations are also stored in `catalog_schema_versions.changes`, which is what a later change replays to rewrite each site's selector spec without calling the model.

**5. One transactional apply per schema change.** In a single transaction: lock the catalog row (`SELECT ... FOR UPDATE`), validate the operations against the current version, build the new version, migrate stored attributes (rename: `attributes - 'old' || jsonb_build_object('new', attributes->'old')`; remove: `attributes - 'old'`), insert the version row, bump `catalogs.schema_version`, and insert `property_pending` markers for added properties. Failure rolls back everything. The row lock serializes concurrent changes to one catalog. `edit_property` and enum additions update in place or add a version without migration; description-only edits do not bump the version, so in-flight work is not invalidated needlessly.

**6. Variant property is fixed at creation; it can be renamed, not removed, retyped or added later.** Adding or removing it would change the price shape (per variant versus per product) of every stored product. Variant values stay in `product_variants.variant_value`, so renaming the property touches only the schema.

**7. Retype is rejected.** String-to-number and similar conversions can fail per value. The clean path is remove plus add, which then needs discovery for the new property.

**8. Version-pinned writes.** Every product write carries the schema version it was produced under and is rejected as stale if it differs from `catalogs.schema_version`, checked inside the same transaction as the write. This protects against a scrape that started before a rename finishing after it and reintroducing the old key. Callers decide whether to retry.

**9. Tenant scoping in the repository layer.** Every repository method takes a customer id and joins through `catalogs.customer_id`; foreign rows return "not found", never "forbidden", so existence does not leak. Integration tests assert this for each entity. Postgres row-level security is deferred to `add-accounts-and-ownership`, where per-request identity exists; session-variable handling with pooled connections is not worth doing before then.

**10. Minimal `customers` table lives here.** Only `id` and `name`. `add-accounts-and-ownership` adds identity (Cognito subjects, operator role) and links logins to customers. This avoids making this change wait for that one.

**11. Price stays `text`**, exactly as scraped; the PRD defers normalization. `products.price`/`available` are used only when the schema has no variant property, enforced in the write path since the rule depends on the catalog's schema.

**11a. Stored values are canonical typed values; conversion from site text happens upstream.** The raw string extracted from a page and the transform that turns it into a typed value (date formats, locale numbers, text-to-enum maps) belong to each site's selector spec and to the scrape run, not to the catalog schema, because formats differ per site while the schema is shared. Raw values are kept in the per-run result in S3 (see `add-queued-scrape-execution`), never in PostgreSQL. This change only defines the canonical form it will accept. `date` is an ISO 8601 calendar date stored as a JSON string in `attributes`, since JSONB has no date type; range queries on it would cast the value, and an expression index per date property can be added later if needed. `datetime` is deferred. Alternatives: a second `attributes_raw` JSONB column (doubles row size and mixes run output into the main store) or native date columns (not possible for customer-defined properties).

**12. Indexes.** GIN on `products.attributes` (`jsonb_ops`, supports `@>`), btree on `products.site_id`, a `to_tsvector` GIN index on `products.name` (configuration deferred), btree on `catalogs.customer_id` and `sites.catalog_id`, and the unique constraints above.

**13. Development seed is optional and explicit.** A configuration switch enables it; it creates a development customer, a catalog with the clothing schema (`gender`, `type`, `size` as variant property, `unit_system`) and the five PRD sites, idempotently. It never runs by default, so a production database starts empty. The previous draft's `cosmetics`/`car_parts` fixtures are dropped: customers now define such schemas themselves, and tests create catalogs with and without a variant property directly.

**14. Integration tests use Testcontainers PostgreSQL.** Real migrations, JSONB queries, locks and constraints. Alternatives: PGlite (index and locking behavior differs) or a shared compose database (state leaks between runs).

## Risks / Trade-offs

- [Rename/remove rewrites every product of a catalog in one transaction] → fine at POC scale; batch the rewrite later if catalogs grow large. The row lock blocks other schema changes and, through the stale-write check, in-flight writes, but not reads.
- [Integration tests need Docker locally and in CI] → keep validators and the operation planner pure so only storage tests need a container.
- [Selector specs are not rewritten by this change, so after a rename a spec still names the old key] → versions record the operations; the spec-storage change must replay them, and runs pin to a schema version so a stale spec's output is rejected rather than stored.
- [Removal is destructive] → data is re-derivable by a scrape, and callers (the API) are expected to ask the customer to confirm.
- [Application-level tenant scoping can be bypassed by a bug] → single repository module, per-entity isolation tests, RLS considered later as defense in depth.
- [Departing from the PRD's table names] → PRD updated in a task so the two do not drift.

## Migration Plan

Nothing is deployed, so there is no data to migrate. Order: dependencies and connection config; pure validators and the operation planner; migrations; the transactional schema-change service; customer-scoped repositories; the product write path; the optional seed; docs. Rollback is a down migration that drops the tables; no other change depends on them yet.

## Open Questions

- Text-search configuration for `products.name` (Spanish stemming versus simple); can change later by rebuilding one index.
- Whether `filterable` should default to true; it affects only the API change and can be decided there.
