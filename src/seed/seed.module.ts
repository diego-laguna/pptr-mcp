import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';
import { runDevSeedIfEnabled } from './dev-seed.js';

@Injectable()
export class DevSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DevSeedService.name);

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationBootstrap(): Promise<void> {
    const result = await runDevSeedIfEnabled(this.pool);
    if (result) {
      this.logger.log(
        `Development seed applied (customer ${result.customerId}, ${result.sitesCreated} new sites)`,
      );
    }
  }
}

@Module({ providers: [DevSeedService] })
export class SeedModule {}
