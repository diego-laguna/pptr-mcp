import { ScrapeMessage } from './messages.js';

export const productionMessage: ScrapeMessage = {
  runId: 'r1',
  mode: 'production',
  customerId: 'c1',
  catalogId: 'k1',
  siteId: 's1',
  specKey: 'customers/c1/sites/s1/specs/1.json',
  specVersion: 1,
  schemaVersion: 2,
  schema: { properties: ['gender', 'size'], variantProperty: 'size' },
};
