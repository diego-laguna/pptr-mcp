import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { TEMPLATE_DB, withDatabase } from './global-setup.js';

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  close(): Promise<void>;
}

// Clones the migrated template into a fresh database for one test file.
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('pgAdminUrl');
  const name = `test_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  await admin.end();

  const url = withDatabase(adminUrl, name);
  const pool = new pg.Pool({ connectionString: url, max: 10 });

  return {
    url,
    pool,
    async close() {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
