import { SchedulerClient } from '@aws-sdk/client-scheduler';
import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import pg from 'pg';
import { DiscoveryModule } from '../discovery/api/discovery.module.js';
import { PG_POOL } from '../database/database.module.js';
import { ScheduleManager } from '../scrape/api/schedule-manager.js';
import { ScrapeModule } from '../scrape/api/scrape.module.js';
import { ScrapeRequestService } from '../scrape/api/scrape-request.service.js';
import { OBJECT_STORE, SPEC_STORE } from '../scrape/api/tokens.js';
import { SpecStore } from '../scrape/spec/spec-store.js';
import { ObjectStore } from '../scrape/storage/object-store.js';
import { loadActivationConfig } from './activation.config.js';
import type { ActivationConfig } from './activation.config.js';
import { ActivationService } from './activation.service.js';
import { InternalActivationController } from './internal-activation.controller.js';
import { ReviewService } from './review.service.js';
import { SchedulePort } from './schedule-port.js';
import { ScheduleService } from './schedule.service.js';

const CONFIG = Symbol('ACTIVATION_CONFIG');
const SCHEDULES = Symbol('SCHEDULE_PORT');

const providers: Provider[] = [
  { provide: CONFIG, useFactory: () => loadActivationConfig() },
  {
    provide: SCHEDULES,
    inject: [CONFIG],
    useFactory: (c: ActivationConfig): SchedulePort =>
      new ScheduleManager(new SchedulerClient({}), {
        groupName: c.scheduleGroupName,
        triggerQueueArn: c.triggerQueueArn,
        roleArn: c.schedulerRoleArn,
      }),
  },
  {
    provide: ActivationService,
    inject: [PG_POOL, SPEC_STORE, SCHEDULES, ScrapeRequestService, CONFIG],
    useFactory: (
      pool: pg.Pool,
      specs: SpecStore,
      schedules: SchedulePort,
      scrapes: ScrapeRequestService,
      c: ActivationConfig,
    ) =>
      new ActivationService({
        pool,
        specs,
        schedules,
        requestScrape: (siteId) =>
          scrapes.request({ mode: 'production', siteId }),
        minIntervalMinutes: c.minIntervalMinutes,
        logger: new Logger('Activation'),
      }),
  },
  {
    provide: ScheduleService,
    inject: [PG_POOL, SCHEDULES, CONFIG],
    useFactory: (pool: pg.Pool, schedules: SchedulePort, c: ActivationConfig) =>
      new ScheduleService({
        pool,
        schedules,
        minIntervalMinutes: c.minIntervalMinutes,
        logger: new Logger('Schedules'),
      }),
  },
  {
    provide: ReviewService,
    inject: [PG_POOL, OBJECT_STORE, SPEC_STORE],
    useFactory: (pool: pg.Pool, objects: ObjectStore, specs: SpecStore) =>
      new ReviewService({ pool, objects, specs }),
  },
];

/** Reconciles schedules with the stored cadences on a timer (and once at start-up). */
@Injectable()
class ScheduleReconciler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('ScheduleReconciler');
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(ScheduleService) private readonly schedules: ScheduleService,
    @Inject(CONFIG) private readonly config: ActivationConfig,
  ) {}

  onApplicationBootstrap() {
    if (
      this.config.reconcileIntervalMinutes === 0 ||
      process.env.SCRAPE_CONSUMERS !== 'true'
    )
      return;
    const run = () =>
      void this.schedules
        .reconcile()
        .then(
          (r) =>
            r.upserted + r.removed > 0 &&
            this.logger.log(
              `reconciled schedules: ${r.upserted} upserted, ${r.removed} removed`,
            ),
        )
        .catch((error) => this.logger.error(error));
    run();
    this.timer = setInterval(
      run,
      this.config.reconcileIntervalMinutes * 60_000,
    );
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }
}

@Module({
  imports: [ScrapeModule, DiscoveryModule],
  controllers: [InternalActivationController],
  providers: [...providers, ScheduleReconciler],
})
export class ActivationModule {}
