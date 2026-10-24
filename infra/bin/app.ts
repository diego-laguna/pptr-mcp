import { App } from 'aws-cdk-lib';
import { DiscoveryStack } from '../lib/discovery-stack.js';
import { ScrapeStack } from '../lib/scrape-stack.js';

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const scrape = new ScrapeStack(app, 'CatalogScrape', { env });
new DiscoveryStack(app, 'CatalogDiscovery', {
  env,
  bucket: scrape.bucket,
  modelProvider: (process.env.DISCOVERY_MODEL_PROVIDER as 'anthropic' | 'bedrock') ?? 'anthropic',
  apiKeySecretName: process.env.ANTHROPIC_API_KEY_SECRET,
});
