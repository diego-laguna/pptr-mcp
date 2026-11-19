import pg from 'pg';

/** Points a site's active spec at a version, as an activation would. */
export async function setActive(
  pool: pg.Pool,
  siteId: string,
  version: number,
) {
  await pool.query(
    `INSERT INTO site_active_specs (site_id, version) VALUES ($1, $2)
     ON CONFLICT (site_id) DO UPDATE SET version = EXCLUDED.version, activated_at = now()`,
    [siteId, version],
  );
}

export async function getActive(
  pool: pg.Pool,
  siteId: string,
): Promise<number | null> {
  const { rows } = await pool.query(
    'SELECT version FROM site_active_specs WHERE site_id = $1',
    [siteId],
  );
  return rows[0]?.version ?? null;
}
