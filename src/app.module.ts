import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ActivationModule } from './activation/activation.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DiscoveryModule } from './discovery/api/discovery.module.js';
import { ScrapeModule } from './scrape/api/scrape.module.js';
import { SeedModule } from './seed/seed.module.js';

@Module({
  imports: [
    DatabaseModule,
    ScrapeModule,
    DiscoveryModule,
    ActivationModule,
    SeedModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
