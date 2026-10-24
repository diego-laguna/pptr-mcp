import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
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
import { PG_POOL } from '../../database/database.module.js';
import { ActiveSpecResolver } from '../../scrape/api/active-spec.js';
import { SQS, ScrapeModule } from '../../scrape/api/scrape.module.js';
import { QueuePoller } from '../../scrape/api/sqs-adapters.js';
import {
  ACTIVE_SPEC_RESOLVER,
  OBJECT_STORE,
  SPEC_STORE,
} from '../../scrape/api/tokens.js';
import { SpecStore } from '../../scrape/spec/spec-store.js';
import { ObjectStore } from '../../scrape/storage/object-store.js';
import { AttemptsRepository } from './attempts.repository.js';
import { DiscoveryFinalizer } from './discovery-finalizer.js';
import { DiscoveryRequestService } from './discovery-request.service.js';
import { loadDiscoveryConfig } from './discovery.config.js';
import type { DiscoveryConfig } from './discovery.config.js';
import { InternalDiscoveryController } from './internal-discovery.controller.js';
import { SpecVersionsRepository } from './spec-versions.repository.js';
import {
  AdmissionPolicy,
  allowAllAdmission,
  DiscoveryMessage,
  DiscoveryQueue,
} from './types.js';

const DISCOVERY_CONFIG = Symbol('DISCOVERY_CONFIG');
const ADMISSION_POLICY = Symbol('ADMISSION_POLICY');
const FINALIZER = Symbol('DISCOVERY_FINALIZER');

class SqsDiscoveryQueue implements DiscoveryQueue {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}
  async send(message: DiscoveryMessage) {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  }
}

const providers: Provider[] = [
  { provide: DISCOVERY_CONFIG, useFactory: () => loadDiscoveryConfig() },
  // Replaced by the budgets change; until then every attempt is admitted.
  { provide: ADMISSION_POLICY, useValue: allowAllAdmission },
  {
    provide: AttemptsRepository,
    inject: [PG_POOL],
    useFactory: (pool: pg.Pool) => new AttemptsRepository(pool),
  },
  {
    provide: SpecVersionsRepository,
    inject: [PG_POOL],
    useFactory: (pool: pg.Pool) => new SpecVersionsRepository(pool),
  },
  {
    provide: DiscoveryRequestService,
    inject: [
      AttemptsRepository,
      SpecVersionsRepository,
      SPEC_STORE,
      ACTIVE_SPEC_RESOLVER,
      SQS,
      DISCOVERY_CONFIG,
      ADMISSION_POLICY,
    ],
    useFactory: (
      attempts: AttemptsRepository,
      versions: SpecVersionsRepository,
      specs: SpecStore,
      active: ActiveSpecResolver,
      sqs: SQSClient,
      config: DiscoveryConfig,
      admission: AdmissionPolicy,
    ) =>
      new DiscoveryRequestService({
        attempts,
        versions,
        specs,
        active,
        admission,
        caps: config.caps,
        queue: new SqsDiscoveryQueue(sqs, config.discoveryQueueUrl),
      }),
  },
  {
    provide: FINALIZER,
    inject: [PG_POOL, AttemptsRepository, SPEC_STORE, OBJECT_STORE],
    useFactory: (
      pool: pg.Pool,
      attempts: AttemptsRepository,
      specs: SpecStore,
      objects: ObjectStore,
    ) => new DiscoveryFinalizer({ pool, attempts, specs, objects }),
  },
];

/** Starts the finished-attempt consumer when SCRAPE_CONSUMERS=true. */
@Injectable()
class DiscoveryConsumers
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('DiscoveryConsumers');
  private poller: QueuePoller | undefined;

  constructor(
    @Inject(SQS) private readonly sqs: SQSClient,
    @Inject(DISCOVERY_CONFIG) private readonly config: DiscoveryConfig,
    @Inject(FINALIZER) private readonly finalizer: DiscoveryFinalizer,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.runConsumers) return;
    this.poller = new QueuePoller(
      this.sqs,
      this.config.finishedQueueUrl,
      (body) => this.finalizer.handle(body),
      (error) => this.logger.error(error),
    );
    this.poller.start();
  }

  async onApplicationShutdown() {
    await this.poller?.stop();
  }
}

@Module({
  imports: [ScrapeModule],
  controllers: [InternalDiscoveryController],
  providers: [...providers, DiscoveryConsumers],
  exports: [SpecVersionsRepository, AttemptsRepository],
})
export class DiscoveryModule {}
