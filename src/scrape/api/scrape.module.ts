import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
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
import { SpecStore } from '../spec/spec-store.js';
import { ObjectStore, S3ObjectStore } from '../storage/object-store.js';
import { PointerActiveSpecResolver } from './active-spec.js';
import { InternalAuthGuard } from './internal-auth.guard.js';
import { InternalScrapeController } from './internal-scrape.controller.js';
import { RunFinalizer } from './run-finalizer.js';
import { RunsRepository } from './runs.repository.js';
import { loadScrapeConfig } from './scrape.config.js';
import type { ScrapeConfig } from './scrape.config.js';
import { NotFoundError } from '../../catalog/errors.js';
import {
  NoActiveSpecError,
  parseScrapeRequest,
  ScrapeRequestService,
} from './scrape-request.service.js';
import {
  QueuePoller,
  SqsFailedScrapePublisher,
  SqsScrapeQueue,
} from './sqs-adapters.js';
import {
  ACTIVE_SPEC_RESOLVER,
  FAILED_SCRAPE_PUBLISHER,
  OBJECT_STORE,
  RECONCILER,
  SCRAPE_CONFIG,
  SCRAPE_QUEUE,
  SPEC_STORE,
} from './tokens.js';
import { Reconciler } from './types.js';

/** Known, deterministic rejections are dropped; anything else is retried by the queue. */
export async function handleTrigger(
  requests: ScrapeRequestService,
  body: unknown,
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  try {
    await requests.request(parseScrapeRequest(body));
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof NoActiveSpecError) {
      logger.warn(`scheduled scrape skipped: ${error.message}`);
      return;
    }
    throw error;
  }
}

export const SQS = Symbol('SQS');
const FINALIZER = Symbol('RUN_FINALIZER');

/** Placeholder until the reconciliation change supplies the real rules. */
class UnimplementedReconciler implements Reconciler {
  private readonly logger = new Logger('Reconciler');
  async reconcile(input: Parameters<Reconciler['reconcile']>[0]) {
    this.logger.warn(
      `no reconciler is installed; run ${input.runId} was not applied`,
    );
  }
}

const providers: Provider[] = [
  { provide: SCRAPE_CONFIG, useFactory: () => loadScrapeConfig() },
  { provide: SQS, useFactory: () => new SQSClient({}) },
  {
    provide: OBJECT_STORE,
    inject: [SCRAPE_CONFIG],
    useFactory: (c: ScrapeConfig) =>
      new S3ObjectStore(new S3Client({}), c.resultsBucket),
  },
  {
    provide: SPEC_STORE,
    inject: [OBJECT_STORE],
    useFactory: (o: ObjectStore) => new SpecStore(o),
  },
  {
    provide: ACTIVE_SPEC_RESOLVER,
    inject: [OBJECT_STORE],
    useFactory: (o: ObjectStore) => new PointerActiveSpecResolver(o),
  },
  {
    provide: SCRAPE_QUEUE,
    inject: [SQS, SCRAPE_CONFIG],
    useFactory: (sqs: SQSClient, c: ScrapeConfig) =>
      new SqsScrapeQueue(sqs, c.scrapeQueueUrl),
  },
  {
    provide: FAILED_SCRAPE_PUBLISHER,
    inject: [SQS, SCRAPE_CONFIG],
    useFactory: (sqs: SQSClient, c: ScrapeConfig) =>
      new SqsFailedScrapePublisher(sqs, c.failedScrapeQueueUrl),
  },
  { provide: RECONCILER, useClass: UnimplementedReconciler },
  {
    provide: RunsRepository,
    inject: [PG_POOL],
    useFactory: (pool: pg.Pool) => new RunsRepository(pool),
  },
  {
    provide: FINALIZER,
    inject: [RunsRepository, OBJECT_STORE, RECONCILER, FAILED_SCRAPE_PUBLISHER],
    useFactory: (
      runs: RunsRepository,
      results: ObjectStore,
      reconciler: Reconciler,
      failures: never,
    ) => new RunFinalizer({ runs, results, reconciler, failures }),
  },
  ScrapeRequestService,
  InternalAuthGuard,
];

/** Starts the results-queue consumer when SCRAPE_CONSUMERS=true. */
@Injectable()
class ScrapeConsumers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ScrapeConsumers');
  private pollers: QueuePoller[] = [];

  constructor(
    @Inject(SQS) private readonly sqs: SQSClient,
    @Inject(SCRAPE_CONFIG) private readonly config: ScrapeConfig,
    @Inject(FINALIZER) private readonly finalizer: RunFinalizer,
    @Inject(ScrapeRequestService)
    private readonly requests: ScrapeRequestService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.runConsumers) return;
    const onError = (error: unknown) => this.logger.error(error);
    this.pollers = [
      new QueuePoller(
        this.sqs,
        this.config.resultsQueueUrl,
        (body) => this.finalizer.handle(body),
        onError,
      ),
      // Scheduled ticks take the same path as the refresh endpoint.
      new QueuePoller(
        this.sqs,
        this.config.triggerQueueUrl,
        (body) => handleTrigger(this.requests, body, this.logger),
        onError,
      ),
    ];
    this.pollers.forEach((p) => p.start());
  }

  async onApplicationShutdown() {
    await Promise.all(this.pollers.map((p) => p.stop()));
  }
}

@Module({
  controllers: [InternalScrapeController],
  providers: [...providers, ScrapeConsumers],
  exports: [
    ScrapeRequestService,
    RunsRepository,
    InternalAuthGuard,
    SCRAPE_CONFIG,
    OBJECT_STORE,
    SPEC_STORE,
    ACTIVE_SPEC_RESOLVER,
    SQS,
  ],
})
export class ScrapeModule {}
