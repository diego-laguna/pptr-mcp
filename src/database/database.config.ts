export interface DatabaseConfig {
  connectionString: string;
  poolMax: number;
}

const DEFAULT_POOL_MAX = 10;

export function loadDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Provide a PostgreSQL connection string, ' +
        'for example postgres://user:password@localhost:5432/catalog',
    );
  }

  const rawPoolMax = env.DATABASE_POOL_MAX?.trim();
  let poolMax = DEFAULT_POOL_MAX;
  if (rawPoolMax) {
    poolMax = Number(rawPoolMax);
    if (!Number.isInteger(poolMax) || poolMax < 1) {
      throw new Error(
        `DATABASE_POOL_MAX must be a positive integer, got "${rawPoolMax}"`,
      );
    }
  }

  return { connectionString, poolMax };
}
