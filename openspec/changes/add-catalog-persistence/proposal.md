# Proposal

## Why

Nothing in the repo stores data yet: it is the bare Nest scaffold. The product is now a multi-tenant service for external customers, each owning several private catalogs whose schema the customer defines, so the PRD's repo-managed templates and five seeded sites no longer describe what must be stored. Reconciliation, discovery, the catalog API and the scraper all depend on this model, so it is settled first.

## What Changes

- Add PostgreSQL schema and versioned migrations for `customers`, `catalogs`, `catalog_schema_versions`, `sites`, `site_attention`, `products` and `product_variants`, with the PRD's indexes (GIN on `attributes`, `site_id`, text search on `name`, `(product_id, variant_value)`) plus ownership indexes.
- **BREAKING (vs. the PRD and the previous draft of this change):** the PRD's `metadata_templates` table and `sites.metadata_template_id` are replaced by a per-catalog, customer-authored schema. Templates are no longer repo-managed and the five target sites are no longer seeded by default.
- A customer owns many catalogs; a catalog owns one versioned schema and many sites; all data is private to the owning customer.
- A schema is a list of typed properties, each with a required description (and optional example), plus at most one variant property fixed at catalog creation. The four system fields (`name`, `link`, `price`, `thumbnail_url`) stay outside the schema.
- Schema changes are explicit operations producing immutable versions: adding a property marks the catalog's sites `property_pending`; renaming or removing a property migrates stored attributes with no discovery; retyping is rejected (remove and re-add); enum values can be added, and removed only when unused.
- Property types include `date`, stored as a canonical ISO 8601 string; converting raw site text into typed values is done upstream by the scrape run, with raw values kept in S3, not in PostgreSQL.
- Product writes are pinned to a schema version and rejected as stale when the catalog has moved on.
- An optional, configuration-enabled development seed creates a development customer with a catalog holding the five PRD sites.

## Capabilities

### New Capabilities
- `customer-catalogs`: customers, the catalogs they own, privacy between customers, catalog creation with an initial schema, and the development seed.
- `catalog-schemas`: customer-authored typed property definitions, the variant property, versioning, and the rules for adding, renaming, removing and retyping properties.
- `site-registry`: sites attached to a catalog, their country and currency, and attention markers.
- `catalog-storage`: products and variants, validation against the catalog schema, version-pinned writes, price shape, and supported lookups.

### Modified Capabilities

None. `openspec/specs/` is empty.

## Impact

- New code: database module for Nest, migrations, a schema-change service, customer-scoped repositories, and the development seed.
- Dependencies: a PostgreSQL driver and a migration tool (see design); no new AWS resources in this change.
- Configuration: database connection settings and the development-seed switch.
- Replaces the earlier draft of this change (repo-managed templates, evolution checks at apply time, `cosmetics`/`car_parts` fixtures, seeded sites).
- Other changes: `add-queued-scrape-execution` still relies on `sites` existing and should pin its runs to a schema version; a new `add-accounts-and-ownership` change adds authentication and links logins to customers (this change only holds the `customers` table and scoping); the PRD's Persistence Layer section needs updating to match.
- Not in scope: authentication, reconcile rules, query endpoints, scraping, selector specs and their rewrite after a rename or removal, discovery, budgets.
