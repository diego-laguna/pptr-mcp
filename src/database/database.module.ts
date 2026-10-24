import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { loadDatabaseConfig } from './database.config.js';

export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): pg.Pool => {
        const config = loadDatabaseConfig();
        return new pg.Pool({
          connectionString: config.connectionString,
          max: config.poolMax,
        });
      },
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
