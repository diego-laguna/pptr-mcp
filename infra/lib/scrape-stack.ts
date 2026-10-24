import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_event_sources as sources,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { join } from 'node:path';

export interface ScrapeStackProps extends StackProps {
  /** Days before raw run results expire. */
  rawResultRetentionDays?: number;
  /** Most scrapes that run at the same time (2 to 1000). */
  maxConcurrentScrapes?: number;
  /** Absolute path of the repository root, where Dockerfile.worker lives. */
  repoRoot?: string;
}

const LAMBDA_TIMEOUT = Duration.seconds(900);

/** Queues, storage and the scrape worker; the API's runtime is defined elsewhere and only its role is created here. */
export class ScrapeStack extends Stack {
  readonly apiRole: iam.Role;
  readonly workerFunction: lambda.DockerImageFunction;
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ScrapeStackProps = {}) {
    super(scope, id, props);
    const retentionDays = props.rawResultRetentionDays ?? 30;
    const repoRoot = props.repoRoot ?? join(import.meta.dirname, '..', '..');

    // --- queues --------------------------------------------------------
    const scrapeDlq = new sqs.Queue(this, 'ScrapeDlq', {
      fifo: true,
      retentionPeriod: Duration.days(14),
    });
    const scrapeQueue = new sqs.Queue(this, 'ScrapeQueue', {
      fifo: true,
      // At least 6x the function timeout, as Lambda requires for event sources.
      visibilityTimeout: Duration.seconds(LAMBDA_TIMEOUT.toSeconds() * 6),
      deadLetterQueue: { queue: scrapeDlq, maxReceiveCount: 3 },
    });
    const resultsQueue = new sqs.Queue(this, 'ResultsQueue', {
      visibilityTimeout: Duration.minutes(5),
    });
    const triggerQueue = new sqs.Queue(this, 'TriggerQueue', {
      visibilityTimeout: Duration.minutes(5),
    });
    const failedScrapeQueue = new sqs.Queue(this, 'FailedScrapeQueue', {
      retentionPeriod: Duration.days(14),
    });

    // --- storage -------------------------------------------------------
    const bucket = (this.bucket = new s3.Bucket(this, 'Bucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Raw run results only; specs live under customers/ and never expire.
          id: 'expire-raw-results',
          prefix: 'runs/',
          expiration: Duration.days(retentionDays),
          noncurrentVersionExpiration: Duration.days(retentionDays),
        },
        {
          // Discovery candidates and evidence (screenshots included) follow the same retention.
          id: 'expire-discovery-evidence',
          prefix: 'discoveries/',
          expiration: Duration.days(retentionDays),
          noncurrentVersionExpiration: Duration.days(retentionDays),
        },
      ],
    }));

    // --- worker (outside any VPC, no database access) -----------------
    this.workerFunction = new lambda.DockerImageFunction(this, 'Worker', {
      code: lambda.DockerImageCode.fromImageAsset(repoRoot, {
        file: 'Dockerfile.worker',
      }),
      memorySize: 2048,
      ephemeralStorageSize: undefined,
      timeout: LAMBDA_TIMEOUT,
      environment: {
        RESULTS_BUCKET: bucket.bucketName,
        RESULTS_QUEUE_URL: resultsQueue.queueUrl,
      },
    });
    this.workerFunction.addEventSource(
      new sources.SqsEventSource(scrapeQueue, {
        batchSize: 1,
        maxConcurrency: props.maxConcurrentScrapes ?? 5,
        reportBatchItemFailures: true,
      }),
    );
    // Read specs, write raw results, report back; nothing else.
    const workerRole = this.workerFunction.role!;
    workerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('customers/*/sites/*/specs/*')],
      }),
    );
    workerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('runs/*')],
      }),
    );
    resultsQueue.grantSendMessages(workerRole);

    // --- scheduler -----------------------------------------------------
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', {
      name: 'scrapes',
    });
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    triggerQueue.grantSendMessages(schedulerRole);

    // --- API role (attached to whatever runs the API) -----------------
    this.apiRole = new iam.Role(this, 'ApiRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    scrapeQueue.grantSendMessages(this.apiRole);
    failedScrapeQueue.grantSendMessages(this.apiRole);
    resultsQueue.grantConsumeMessages(this.apiRole);
    triggerQueue.grantConsumeMessages(this.apiRole);
    scrapeDlq.grantConsumeMessages(this.apiRole);
    bucket.grantRead(this.apiRole);
    this.apiRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
        ],
        resources: [
          this.formatArn({
            service: 'scheduler',
            resource: 'schedule',
            resourceName: `${scheduleGroup.name}/*`,
          }),
        ],
      }),
    );
    this.apiRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      }),
    );
    this.apiRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('customers/*/sites/*/specs/*')],
      }),
    );
  }
}
