import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from './migrate.js';

export const TEMPLATE_DB = 'catalog_template';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

// One container for the whole run; migrations are applied once to a template
// database that every test file clones, so tests stay isolated and fast.
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const adminUrl = container.getConnectionUri();

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();

  const templateUrl = withDatabase(adminUrl, TEMPLATE_DB);
  await migrate(templateUrl, 'up');

  project.provide('pgAdminUrl', adminUrl);

  return async () => {
    await container.stop();
  };
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
