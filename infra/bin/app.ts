import { App } from 'aws-cdk-lib';
import { ScrapeStack } from '../lib/scrape-stack.js';

const app = new App();
new ScrapeStack(app, 'CatalogScrape', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
