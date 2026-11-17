import { App } from 'aws-cdk-lib';
import { DiscoveryStack } from '../lib/discovery-stack.js';
import { ScrapeStack } from '../lib/scrape-stack.js';

const app = new App();
// `-c local=true` (see scripts/local-deploy.sh) targets the emulator: stub images, no registry.
const localStubImages = app.node.tryGetContext('local')?.toString() === 'true';
// The CDK CLI overwrites CDK_DEFAULT_* from the user's AWS profile, so local runs pin the emulator's account and region.
const env = localStubImages
  ? { account: '000000000000', region: 'us-east-1' }
  : { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
if (localStubImages) {
  // Answers the AZ lookup up front; otherwise synth needs real AWS credentials for the emulator's fake account.
  app.node.setContext('availability-zones:account=000000000000:region=us-east-1', ['us-east-1a', 'us-east-1b']);
}
const scrape = new ScrapeStack(app, 'CatalogScrape', { env, localStubImages });
new DiscoveryStack(app, 'CatalogDiscovery', {
  env,
  localStubImages,
  bucket: scrape.bucket,
  modelProvider: (process.env.DISCOVERY_MODEL_PROVIDER as 'anthropic' | 'bedrock') ?? 'anthropic',
  apiKeySecretName: process.env.ANTHROPIC_API_KEY_SECRET,
});
