# Tasks

## 1. Database setup

- [ ] 1.1 Add `pg`, `node-pg-migrate` and `@testcontainers/postgresql` (dev) and a migrate script to `package.json`; verify `pnpm install` and `pnpm build` succeed
- [ ] 1.2 Add database connection configuration (env-driven) and a Nest database module exposing a pool; verify a unit test shows missing configuration fails fast with a clear error
- [ ] 1.3 Add a Testcontainers helper that starts PostgreSQL and runs migrations for integration tests; verify a smoke test connects and runs `select 1`

## 2. Schema definitions and change planning (pure code)

- [ ] 2.1 Implement the property and schema validator (name format, reserved names, uniqueness, 50-property limit, required description, enum values, example conforms to type including the canonical `YYYY-MM-DD` form for `date`, at most one variant property); verify unit tests cover every scenario under "Property definition", "Property names", "Schema size limit" and "Optional variant property" in the catalog-schemas spec
- [ ] 2.2 Implement the operation planner that takes the current schema plus explicit operations (`add_property`, `rename_property`, `remove_property`, `edit_property`, `add_enum_value`, `remove_enum_value`) and returns the new schema, a change log and the effects (attribute migrations, properties needing sites marked); verify unit tests cover add, rename, remove, collision, retype rejection, variant property rename/removal and required-property-add cases
- [ ] 2.3 Implement the attribute validator used on product writes (declared properties only, type and enum checks, `date` accepted only as a valid ISO calendar date, required properties); verify unit tests cover undeclared key, wrong type, value outside enum, valid date, `15/10/2026` and `2026-02-31` rejected, optional missing and required missing

## 3. Schema and migrations

- [ ] 3.1 Write the migration for `customers`, `catalogs` (unique `(customer_id, name)`) and `catalog_schema_versions`; verify an integration test rejects a duplicate catalog name for one customer and accepts the same name for two customers
- [ ] 3.2 Write the migration for `sites` (unique `(catalog_id, url)`) and `site_attention`; verify integration tests reject a duplicate URL in one catalog, accept it in another, and cascade-delete attention rows with the site
- [ ] 3.3 Write the migration for `products` and `product_variants` with the unique keys, `ON DELETE CASCADE`, `timestamptz` timestamps and text `price`; verify integration tests reject duplicate `(site_id, link)` and `(product_id, variant_value)` and show deleting a product removes its variants
- [ ] 3.4 Add the GIN index on `attributes`, `site_id`, `catalog_id`, `customer_id` and name text-search indexes; verify with `EXPLAIN` in an integration test that attribute containment and name search use their indexes on seeded data
- [ ] 3.5 Add a down migration; verify migrating up, down and up again leaves a working schema

## 4. Catalogs, sites and tenant scoping

- [ ] 4.1 Implement customer and catalog repositories (create catalog with initial schema as version 1, list, get) scoped by customer id; verify integration tests cover the scenarios in the customer-catalogs spec including invalid initial schema leaving nothing stored
- [ ] 4.2 Implement the site repository (add, list, remove with product cascade) and attention markers (create, clear with history retained); verify integration tests cover the site-registry spec scenarios, including a site added to another customer's catalog being "not found"
- [ ] 4.3 Verify tenant isolation for every entity: catalog, schema, site, product and lookup access by another customer returns "not found"; one integration test per entity

## 5. Schema change service

- [ ] 5.1 Implement the transactional schema-change service (lock catalog row, plan operations, migrate attributes for rename/remove, insert the version with its change log, bump the current version, create `property_pending` markers); verify integration tests for add with three sites, rename with stored products (old key gone, value kept) and remove with stored products
- [ ] 5.2 Enforce the rejections: required-property add with existing products, retype, variant property removal or later designation, name collision, enum value in use; verify each leaves schema, data and markers unchanged
- [ ] 5.3 Verify atomicity and concurrency: a forced failure during a rename migration rolls everything back, and two simultaneous changes to one catalog produce two sequential versions; integration tests for both
- [ ] 5.4 Verify description-only and enum-addition edits do not migrate data and description-only edits do not bump the version; integration test

## 6. Product write path

- [ ] 6.1 Implement the product and variant repository that validates attributes against the catalog's current schema and rejects writes pinned to a stale schema version in the same transaction; verify integration tests for the stale and current scenarios in the catalog-storage spec
- [ ] 6.2 Enforce the price shape rule using catalogs with and without a variant property; verify both rejections and both accepted shapes
- [ ] 6.3 Verify the supported lookups through the repository: by catalog and site, attribute containment (`girls` + `t-shirt`), name search, variants by value, and the same query as another customer returning nothing; integration tests assert only matching rows return
- [ ] 6.4 Verify price text round-trips exactly (for example `$ 12.990,00`) with an integration test

## 7. Development seed

- [ ] 7.1 Implement the optional seed (development customer, clothing catalog with `gender`, `type`, `size` as variant property and `unit_system`, five PRD sites), enabled only by configuration and idempotent; verify integration tests for enabled, not enabled and applied twice with unchanged ids
- [ ] 7.2 Wire the seed to a script and to application start-up behind the configuration switch; verify a fresh database starts empty by default and populated when the switch is on

## 8. Documentation

- [ ] 8.1 Document the data model, the schema-change operations and their effects, tenant scoping, and how to run migrations and the dev seed in `docs/`; verify the documented commands run as written on a fresh checkout
- [ ] 8.2 Update the PRD's Persistence Layer and Backend sections and `docs/TECH_STACK.md` (customers and catalogs, per-catalog schema replacing templates, migration tool, driver, test approach); verify they match the specs and `package.json`
