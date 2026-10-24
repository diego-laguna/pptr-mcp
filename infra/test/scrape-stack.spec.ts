import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrapeStack } from '../lib/scrape-stack.js';

// A stand-in build context keeps synth fast and independent of the real image.
const repoRoot = mkdtempSync(join(tmpdir(), 'ctx-'));
writeFileSync(join(repoRoot, 'Dockerfile.worker'), 'FROM scratch\n');

const template = Template.fromStack(
  new ScrapeStack(new App(), 'Test', { repoRoot, env: { account: '111111111111', region: 'us-east-1' } }),
);

const policies = () =>
  Object.values(template.findResources('AWS::IAM::Policy')) as {
    Properties: { PolicyName: string; PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } };
  }[];
const actionsOf = (match: RegExp) =>
  policies()
    .filter((p) => match.test(p.Properties.PolicyName))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

describe('queues', () => {
  it('has a FIFO scrape queue with a visibility timeout of at least 6x the function timeout and a 3-receive DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      FifoQueue: true,
      VisibilityTimeout: 900 * 6,
      RedrivePolicy: { maxReceiveCount: 3, deadLetterTargetArn: Match.anyValue() },
    });
  });

  it('has a FIFO dead-letter queue, a results queue, a trigger queue and a failed_scrape queue', () => {
    template.resourceCountIs('AWS::SQS::Queue', 5);
    const fifo = Object.values(template.findResources('AWS::SQS::Queue')).filter(
      (q) => (q as { Properties: { FifoQueue?: boolean } }).Properties.FifoQueue,
    );
    expect(fifo).toHaveLength(2);
  });
});

describe('bucket', () => {
  it('is versioned, private, and expires raw results after 30 days without touching specs', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            ExpirationInDays: 30,
            Prefix: 'runs/',
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });
});

describe('worker', () => {
  it('is a 900 s, 2 GB container image outside any VPC', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      MemorySize: 2048,
      Timeout: 900,
      VpcConfig: Match.absent(),
    });
  });

  it('is fed by the scrape queue with capped concurrency, one record at a time, reporting item failures', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 5 },
    });
  });
});

describe('IAM', () => {
  it('limits the worker role to reading specs, writing results and reporting back', () => {
    const doc = JSON.stringify(
      policies().find((p) => /WorkerServiceRole/.test(p.Properties.PolicyName))!.Properties.PolicyDocument,
    );
    expect(doc).toContain('customers/*/sites/*/specs/*');
    expect(doc).toContain('runs/*');
    // no database, no scheduler, no wildcard grants, no IAM
    expect(doc).not.toMatch(/rds|secretsmanager|scheduler:|iam:|"Action":"\*"|"Resource":"\*"/);
    const actions = actionsOf(/WorkerServiceRole/);
    expect(actions.sort()).toEqual(
      expect.arrayContaining(['s3:GetObject', 's3:PutObject', 'sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage']),
    );
    expect(actions.every((a) => /^(s3|sqs):/.test(a))).toBe(true);
  });

  it('lets the API enqueue, consume results and manage schedules, and pass only the scheduler role', () => {
    const doc = JSON.stringify(
      policies().find((p) => /ApiRole/.test(p.Properties.PolicyName))!.Properties.PolicyDocument,
    );
    for (const action of ['sqs:SendMessage', 'sqs:ReceiveMessage', 'scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'iam:PassRole']) {
      expect(doc).toContain(action);
    }
    expect(doc).toContain('scheduler.amazonaws.com');
  });

  it('lets the scheduler role only send to the trigger queue', () => {
    const actions = actionsOf(/SchedulerRole/);
    expect([...new Set(actions)].sort()).toEqual(['sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage']);
  });
});

describe('scheduler', () => {
  it('has a schedule group for per-site schedules', () => {
    template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', { Name: 'scrapes' });
  });
});
