-- Up Migration

CREATE TABLE scrape_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('production', 'preview')),
  spec_version integer NOT NULL CHECK (spec_version >= 1),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  reason text,
  detail text,
  item_count integer,
  page_count integer,
  result_key text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- At most one pending production run per site ...
CREATE UNIQUE INDEX scrape_runs_pending_production_key
  ON scrape_runs (site_id)
  WHERE mode = 'production' AND status IN ('queued', 'running');

-- ... and one pending preview per site and spec version.
CREATE UNIQUE INDEX scrape_runs_pending_preview_key
  ON scrape_runs (site_id, spec_version)
  WHERE mode = 'preview' AND status IN ('queued', 'running');

-- Finds the previous complete run for the count-deviation check.
CREATE INDEX scrape_runs_last_complete_idx
  ON scrape_runs (site_id, finished_at DESC)
  WHERE mode = 'production' AND status = 'succeeded';

-- Down Migration

DROP TABLE scrape_runs;
