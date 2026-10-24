-- Up Migration

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (btrim(name) <> ''),
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalogs_customer_name_key UNIQUE (customer_id, name)
);

CREATE TABLE catalog_schema_versions (
  catalog_id uuid NOT NULL REFERENCES catalogs (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  version integer NOT NULL CHECK (version >= 1),
  properties jsonb NOT NULL,
  variant_property text,
  changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (catalog_id, version)
);

-- The current version must exist. Deferred so a catalog and its version 1 can
-- be inserted in one transaction, in either order.
ALTER TABLE catalogs
  ADD CONSTRAINT catalogs_current_version_fk
  FOREIGN KEY (id, schema_version)
  REFERENCES catalog_schema_versions (catalog_id, version)
  DEFERRABLE INITIALLY DEFERRED;

-- Down Migration

ALTER TABLE catalogs DROP CONSTRAINT catalogs_current_version_fk;
DROP TABLE catalog_schema_versions;
DROP TABLE catalogs;
DROP TABLE customers;
