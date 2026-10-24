-- Up Migration

CREATE TABLE discovery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('full', 'incremental', 'repair')),
  target_properties text[] NOT NULL DEFAULT '{}',
  guidance text CHECK (guidance IS NULL OR char_length(guidance) <= 2000),
  base_version integer,
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  schema_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'candidate_ready', 'failed')),
  reason text,
  detail text,
  spec_version integer,
  usage jsonb,
  evidence_key text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- One queued or running attempt per site.
CREATE UNIQUE INDEX discovery_attempts_pending_key
  ON discovery_attempts (site_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE site_spec_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  source text NOT NULL DEFAULT 'discovery' CHECK (source IN ('discovery')),
  mode text NOT NULL CHECK (mode IN ('full', 'incremental', 'repair')),
  attempt_id uuid NOT NULL REFERENCES discovery_attempts (id),
  base_version integer,
  schema_version integer NOT NULL,
  bound_properties text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_spec_versions_site_version_key UNIQUE (site_id, version)
);

-- Properties a scrape reported as failing, the default targets of a repair.
ALTER TABLE scrape_runs ADD COLUMN failing_properties text[] NOT NULL DEFAULT '{}';

-- Down Migration

ALTER TABLE scrape_runs DROP COLUMN failing_properties;
DROP TABLE site_spec_versions;
DROP TABLE discovery_attempts;
