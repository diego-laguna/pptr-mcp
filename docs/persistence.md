# Persistence

PostgreSQL holds customers, their catalogs and catalog schemas, sites, and the products scraped from them. Access is through `pg` with plain SQL; migrations are SQL files run by `node-pg-migrate`. There is no ORM.

## Data model

```
customers(id, name, created_at)
  |
catalogs(id, customer_id, name, schema_version, created_at)        unique(customer_id, name)
  |-- catalog_schema_versions(catalog_id, version, properties JSONB,
  |                           variant_property, changes JSONB, created_at)
  |-- sites(id, catalog_id, url, name, country, currency, created_at)   unique(catalog_id, url)
        |-- site_attention(id, site_id, reason, property, created_at, cleared_at)
        |-- products(id, site_id, name, link, thumbnail_url, attributes JSONB,
                     price, available, updated_at)                      unique(site_id, link)
              |-- product_variants(id, product_id, variant_value, price,
                                   available, updated_at)               unique(product_id, variant_value)
```

- A **customer** owns many **catalogs**. A catalog owns one schema, stored as immutable numbered versions; `catalogs.schema_version` points at the current one (a deferred foreign key guarantees it exists).
- A **site** belongs to one catalog and is scraped under that catalog's schema. A site has no schema of its own.
- Deleting a site deletes its products, their variants and its attention markers.
- `price` is text exactly as shown on the site (for example `$ 12.990,00`). It sits on `product_variants` when the schema has a variant property, otherwise on `products`.
- Timestamps are `timestamptz`.

### Catalog schema

A schema is a list of at most 50 properties. Each has a `name` (lowercase letters, digits and underscores, starting with a letter; not a system field name: `name`, `link`, `price`, `thumbnail_url`, `updated`, `available`), a `type`, a non-empty `description`, and `required` and `filterable` flags (both default to false). An optional `example` must conform to the type, and enum properties list their allowed `values`.

| Type | Stored as |
| --- | --- |
| `string` | JSON string |
| `number` | JSON number |
| `boolean` | JSON boolean |
| `url` | absolute http(s) URL string |
| `date` | ISO 8601 calendar date string `YYYY-MM-DD`; impossible dates such as `2026-02-31` are rejected |
| `enum` | one of the listed `values` |
| `string_list` | JSON array of strings |

Stored values are always canonical. Turning site text such as `15/10/2026` into `2026-10-15` happens upstream, in the scrape run.

A schema may designate one **variant property** (for example `size`) when the catalog is created. It splits a product into separately priced variants stored in `product_variants`; it is not part of `attributes`. It can be renamed but never removed, retyped or designated later.

## Schema changes

Changes are explicit operations, applied in order to one catalog inside a single transaction (`SchemaChangeService.apply`). The catalog row is locked, so concurrent changes run one after the other and each produces its own version.

| Operation | Effect |
| --- | --- |
| `add_property` | New schema version. Stored products are untouched. Every site of the catalog gets a `property_pending` attention marker naming the property. A required property is rejected when the catalog already has products. |
| `rename_property` | New schema version. The key is renamed in every product's `attributes`, no discovery needed, no markers created. A pending marker for the property follows the new name. The variant property can be renamed (variants keep their values). Name collisions are rejected. |
| `remove_property` | New schema version. The key is deleted from every product's `attributes`. A pending marker for it is cleared. The variant property cannot be removed. |
| `edit_property` | Description, example and `filterable` are edited in place; the version number does not change. Changing `type` is rejected: remove the property and add it again. |
| `add_enum_value` | New schema version. No data migration, no markers. |
| `remove_enum_value` | New schema version. Rejected while any stored product uses the value. |

Every version stores the operations that produced it in `catalog_schema_versions.changes`, so a later change can replay them. If any part fails (validation, data migration, marker creation), the version, the stored attributes and the markers are all left as they were.

Writes are **pinned to a schema version**. `ProductsRepository.create` and `update` take the version the data was produced under and reject it as stale if the catalog has moved on. The check happens in the same transaction as the write, with the catalog row held in share mode so a schema change cannot interleave.

## Tenant scoping

Every repository method takes a customer id and reaches rows through `catalogs.customer_id`. A row owned by another customer behaves exactly like a missing one: reads and writes fail with "not found" and searches return nothing, so existence never leaks. Integration tests cover every entity (catalogs, schema versions, sites, markers, products). Row-level security is left for the accounts change, when a per-request identity exists.

## Running it

The database is configured through environment variables:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string, required (the app and the scripts stop with a clear error without it) |
| `DATABASE_POOL_MAX` | Connection pool size, default 10 |
| `SEED_DEV_DATA` | `true` applies the development seed at start-up; anything else (the default) does not |

Start a local database, apply the migrations and run the app:

```bash
docker run -d --name catalog-db -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=catalog -p 5432:5432 postgres:17-alpine
export DATABASE_URL=postgres://postgres:pw@localhost:5432/catalog

pnpm install
pnpm migrate:up      # apply all migrations
pnpm migrate:down    # revert the latest migration (run repeatedly to go further)
pnpm start:dev
```

New migration: `pnpm migrate create <name>` creates an SQL file in `migrations/` with `-- Up Migration` and `-- Down Migration` sections.

### Development seed

The seed creates one development customer with a "Kids clothing (Argentina)" catalog (`gender`, `type`, `size` as the variant property, and `unit_system`) and the five target sites (Grisino, Cheeky, Naranjo, Mimo, Baby Cottons; country `AR`, currency `ARS`). It is idempotent: applying it again changes nothing, and it restores a missing seed site without touching the others. It never runs unless asked:

```bash
pnpm build
pnpm seed:dev                   # one-off, against DATABASE_URL
SEED_DEV_DATA=true pnpm start   # or apply it at application start-up
```

A database that is started without `SEED_DEV_DATA=true` stays empty.

## Tests

```bash
pnpm test        # unit tests: schema validator, operation planner, attribute validator, config
pnpm test:e2e    # application wiring
pnpm test:int    # integration tests against a real PostgreSQL started by Testcontainers (needs Docker)
```

The integration run starts one PostgreSQL container, applies the migrations once to a template database, and gives every test file its own clone, so files do not share state.
