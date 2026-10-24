import {
  Duration,
  Stack,
  StackProps,
  aws_cloudwatch as cloudwatch,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs,
  aws_applicationautoscaling as appscaling,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { join } from 'node:path';

export interface DiscoveryStackProps extends StackProps {
  /** The bucket that holds specs and evidence (created by the scrape stack). */
  bucket: s3.IBucket;
  /** Absolute path of the repository root, where Dockerfile.discovery lives. */
  repoRoot?: string;
  /** Longest an attempt may run; the queue's visibility timeout is derived from it. */
  maxAttemptMinutes?: number;
  maxWorkers?: number;
  /** Which model provider the worker uses (decided in task 5.4). */
  modelProvider?: 'anthropic' | 'bedrock';
  /** Name of the Secrets Manager secret holding ANTHROPIC_API_KEY (anthropic provider). */
  apiKeySecretName?: string;
}

/** Discovery queue, finished-attempt queue and the Fargate worker service that scales 0 to 2 on queue depth. */
export class DiscoveryStack extends Stack {
  readonly discoveryQueue: sqs.Queue;
  readonly finishedQueue: sqs.Queue;
  readonly taskRole: iam.Role;
  readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: DiscoveryStackProps) {
    super(scope, id, props);
    const maxAttempt = Duration.minutes(props.maxAttemptMinutes ?? 20);
    const maxWorkers = props.maxWorkers ?? 2;
    const repoRoot = props.repoRoot ?? join(import.meta.dirname, '..', '..');

    // --- queues --------------------------------------------------------
    const dlq = new sqs.Queue(this, 'DiscoveryDlq', { retentionPeriod: Duration.days(14) });
    this.discoveryQueue = new sqs.Queue(this, 'DiscoveryQueue', {
      // Well above the longest attempt; the worker also extends visibility while it runs.
      visibilityTimeout: Duration.seconds(maxAttempt.toSeconds() * 2),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });
    this.finishedQueue = new sqs.Queue(this, 'FinishedAttemptQueue', {
      visibilityTimeout: Duration.minutes(5),
    });

    // --- network: its own VPC, no peering or route to the database ----
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'worker', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const securityGroup = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc,
      allowAllOutbound: false,
      description: 'Discovery workers: web egress only',
    });
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), 'DNS');
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(53), 'DNS');

    // --- worker task ---------------------------------------------------
    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // Reads base specs, writes candidates and evidence; nothing else in the bucket.
    this.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [props.bucket.arnForObjects('customers/*/sites/*/specs/*')],
      }),
    );
    this.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [props.bucket.arnForObjects('discoveries/*')],
      }),
    );
    this.discoveryQueue.grantConsumeMessages(this.taskRole);
    this.discoveryQueue.grant(this.taskRole, 'sqs:ChangeMessageVisibility');
    this.finishedQueue.grantSendMessages(this.taskRole);
    if (props.modelProvider === 'bedrock') {
      this.taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [`arn:${this.partition}:bedrock:*::foundation-model/*`, `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`],
        }),
      );
    }

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 2048,
      memoryLimitMiB: 4096,
      taskRole: this.taskRole,
    });
    const secrets: Record<string, ecs.Secret> = {};
    if (props.modelProvider !== 'bedrock' && props.apiKeySecretName) {
      secrets.ANTHROPIC_API_KEY = ecs.Secret.fromSecretsManager(
        secretsmanager.Secret.fromSecretNameV2(this, 'ApiKey', props.apiKeySecretName),
      );
    }
    taskDefinition.addContainer('worker', {
      image: ecs.ContainerImage.fromAsset(repoRoot, { file: 'Dockerfile.discovery' }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'discovery' }),
      environment: {
        RESULTS_BUCKET: props.bucket.bucketName,
        DISCOVERY_QUEUE_URL: this.discoveryQueue.queueUrl,
        DISCOVERY_FINISHED_QUEUE_URL: this.finishedQueue.queueUrl,
        MAX_RUN_MS: String(maxAttempt.toMilliseconds()),
        ...(props.modelProvider === 'bedrock' ? { CLAUDE_CODE_USE_BEDROCK: '1' } : {}),
      },
      secrets,
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: new ecs.Cluster(this, 'Cluster', { vpc }),
      taskDefinition,
      desiredCount: 0,
      assignPublicIp: true,
      securityGroups: [securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // 0 to 2 tasks by queue depth (messages waiting plus messages being worked on).
    const scaling = this.service.autoScaleTaskCount({ minCapacity: 0, maxCapacity: maxWorkers });
    const depth = new cloudwatch.MathExpression({
      expression: 'visible + inflight',
      usingMetrics: {
        visible: this.discoveryQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
        inflight: this.discoveryQueue.metricApproximateNumberOfMessagesNotVisible({ period: Duration.minutes(1) }),
      },
      period: Duration.minutes(1),
    });
    scaling.scaleOnMetric('QueueDepth', {
      metric: depth,
      adjustmentType: appscaling.AdjustmentType.EXACT_CAPACITY,
      scalingSteps: [
        { upper: 0, change: 0 },
        { lower: 1, upper: 2, change: 1 },
        { lower: 2, change: maxWorkers },
      ],
      cooldown: Duration.minutes(2),
    });
  }
}
