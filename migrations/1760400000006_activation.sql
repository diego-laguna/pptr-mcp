-- Up Migration

CREATE TABLE site_active_specs (
  site_id uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  activated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  replaced_version integer,
  preview_run_id uuid REFERENCES scrape_runs (id) ON DELETE SET NULL,
  acknowledged_properties text[] NOT NULL DEFAULT '{}',
  approved_by text,
  activated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX site_activations_site_idx ON site_activations (site_id, activated_at DESC);

-- The customer's chosen cadence; the EventBridge schedule mirrors it.
CREATE TABLE site_schedules (
  site_id uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  expression text NOT NULL CHECK (btrim(expression) <> ''),
  timezone text NOT NULL DEFAULT 'UTC',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE site_spec_versions ADD COLUMN discarded_at timestamptz;

-- Down Migration

ALTER TABLE site_spec_versions DROP COLUMN discarded_at;
DROP TABLE site_schedules;
DROP TABLE site_activations;
DROP TABLE site_active_specs;
