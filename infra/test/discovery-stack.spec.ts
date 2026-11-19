import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscoveryStack } from '../lib/discovery-stack.js';
import { ScrapeStack } from '../lib/scrape-stack.js';

const repoRoot = mkdtempSync(join(tmpdir(), 'ctx-'));
for (const f of ['Dockerfile.worker', 'Dockerfile.discovery']) writeFileSync(join(repoRoot, f), 'FROM scratch\n');
const env = { account: '111111111111', region: 'us-east-1' };

function synth(provider: 'anthropic' | 'bedrock' = 'anthropic') {
  const app = new App();
  const scrape = new ScrapeStack(app, 'S', { repoRoot, env });
  const stack = new DiscoveryStack(app, 'D', { bucket: scrape.bucket, repoRoot, env, modelProvider: provider, apiKeySecretName: 'discovery/anthropic' });
  return { template: Template.fromStack(stack), scrapeTemplate: Template.fromStack(scrape) };
}
const { template, scrapeTemplate } = synth();

const policies = (t: Template) =>
  Object.values(t.findResources('AWS::IAM::Policy')) as {
    Properties: { PolicyName: string; PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } };
  }[];

describe('queues (5.1)', () => {
  it('has a discovery queue whose visibility timeout exceeds the longest attempt, with a 3-receive DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 20 * 60 * 2,
      RedrivePolicy: { maxReceiveCount: 3, deadLetterTargetArn: Match.anyValue() },
    });
    template.resourceCountIs('AWS::SQS::Queue', 3); // discovery, its DLQ, finished-attempt
  });

  it('expires discovery evidence on the same schedule as raw results', () => {
    scrapeTemplate.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'runs/', ExpirationInDays: 30, Status: 'Enabled' }),
          Match.objectLike({ Prefix: 'discoveries/', ExpirationInDays: 30, Status: 'Enabled' }),
        ]),
      },
    });
  });
});

describe('service (5.2 definition)', () => {
  it('is a Fargate service that starts at zero and scales between 0 and 2 on queue depth', () => {
    template.hasResourceProperties('AWS::ECS::Service', { LaunchType: 'FARGATE', DesiredCount: 0 });
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 0, MaxCapacity: 2 });
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', { PolicyType: 'StepScaling' });
  });

  it('runs in its own VPC with no NAT, no database route and web-only egress', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::VPCPeeringConnection', 0);
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupEgress: Match.arrayWith([Match.objectLike({ FromPort: 443, ToPort: 443 }), Match.objectLike({ FromPort: 80, ToPort: 80 })]),
    });
    const sg = Object.values(template.findResources('AWS::EC2::SecurityGroup'))
      .flatMap((r) => (r as { Properties: { SecurityGroupEgress?: { FromPort?: number }[] } }).Properties.SecurityGroupEgress ?? []);
    expect(sg.every((rule) => [80, 443, 53].includes(rule.FromPort!))).toBe(true);
  });
});

describe('task role (5.3)', () => {
  const taskPolicy = () => policies(template).find((p) => /TaskRole/.test(p.Properties.PolicyName))!.Properties.PolicyDocument;

  it('reads specs, writes only discoveries/, uses its two queues, and has nothing else', () => {
    const doc = JSON.stringify(taskPolicy());
    expect(doc).toContain('customers/*/sites/*/specs/*');
    expect(doc).toContain('discoveries/*');
    expect(doc).not.toMatch(/rds|rds-data|secretsmanager:\*|scheduler:|iam:|"Action":"\*"|"Resource":"\*"/);
    const actions = taskPolicy().Statement.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions.every((a) => /^(s3|sqs):/.test(a))).toBe(true);
    expect(actions).toEqual(expect.arrayContaining(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:SendMessage', 's3:GetObject', 's3:PutObject']));
  });

  it('adds Bedrock invocation only when Bedrock is the provider', () => {
    expect(JSON.stringify(taskPolicy())).not.toContain('bedrock:');
    const bedrock = synth('bedrock').template;
    const doc = JSON.stringify(policies(bedrock).find((p) => /TaskRole/.test(p.Properties.PolicyName))!.Properties.PolicyDocument);
    expect(doc).toContain('bedrock:InvokeModel');
  });
});
