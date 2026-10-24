-- Up Migration

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  name text NOT NULL,
  link text NOT NULL,
  thumbnail_url text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  -- Price text exactly as shown on the site. Used only when the catalog schema
  -- has no variant property; enforced in the write path.
  price text,
  available boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_site_link_key UNIQUE (site_id, link)
);

CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  variant_value text NOT NULL,
  price text NOT NULL,
  available boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_variants_product_value_key UNIQUE (product_id, variant_value)
);

-- Down Migration

DROP TABLE product_variants;
DROP TABLE products;
