-- Up Migration

-- Attribute containment (attributes @> '{"gender":"girls"}').
CREATE INDEX products_attributes_gin_idx ON products USING gin (attributes jsonb_ops);

-- Free text on product name. The 'simple' configuration is a placeholder until
-- the language question is decided; queries must use the same expression.
CREATE INDEX products_name_fts_idx ON products USING gin (to_tsvector('simple', name));

-- Variants by value across products.
CREATE INDEX product_variants_value_idx ON product_variants (variant_value);

-- Lookups by site, catalog and customer are served by the leading columns of
-- the unique constraints: products (site_id, link), sites (catalog_id, url)
-- and catalogs (customer_id, name).

-- Down Migration

DROP INDEX product_variants_value_idx;
DROP INDEX products_name_fts_idx;
DROP INDEX products_attributes_gin_idx;
