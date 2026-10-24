import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { SeedModule } from './seed/seed.module.js';

@Module({
  imports: [DatabaseModule, SeedModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
