import pg from 'pg';
import { loadDatabaseConfig } from '../database/database.config.js';
import { isDevSeedEnabled, runDevSeedIfEnabled } from './dev-seed.js';

// Usage: SEED_DEV_DATA=true DATABASE_URL=... node dist/seed/run-seed.js
if (!isDevSeedEnabled()) {
  console.error(
    'Refusing to seed: set SEED_DEV_DATA=true to apply the development seed.',
  );
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: loadDatabaseConfig().connectionString,
});
try {
  const result = await runDevSeedIfEnabled(pool);
  console.log(
    `Development seed applied: customer ${result?.customerId}, catalog ${result?.catalogId}, ${result?.sitesCreated} new sites`,
  );
} finally {
  await pool.end();
}
