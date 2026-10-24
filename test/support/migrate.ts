import { runner } from 'node-pg-migrate';

export async function migrate(
  databaseUrl: string,
  direction: 'up' | 'down' = 'up',
  count: number = direction === 'up' ? Infinity : 1,
): Promise<void> {
  await runner({
    databaseUrl,
    dir: 'migrations',
    migrationsTable: 'pgmigrations',
    direction,
    count,
    log: () => {},
  });
}
