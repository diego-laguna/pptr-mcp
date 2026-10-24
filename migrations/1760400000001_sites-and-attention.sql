-- Up Migration

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id uuid NOT NULL REFERENCES catalogs (id) ON DELETE CASCADE,
  url text NOT NULL CHECK (btrim(url) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sites_catalog_url_key UNIQUE (catalog_id, url)
);

CREATE TABLE site_attention (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  property text,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz
);

CREATE INDEX site_attention_active_idx ON site_attention (site_id) WHERE cleared_at IS NULL;

-- Down Migration

DROP TABLE site_attention;
DROP TABLE sites;
