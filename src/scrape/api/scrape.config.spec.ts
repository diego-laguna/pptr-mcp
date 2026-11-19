import { loadScrapeConfig } from './scrape.config.js';

const base = {
  SCRAPE_QUEUE_URL: 'q',
  RESULTS_QUEUE_URL: 'r',
  FAILED_SCRAPE_QUEUE_URL: 'f',
  TRIGGER_QUEUE_URL: 'g',
  RESULTS_BUCKET: 'b',
  INTERNAL_API_TOKEN: 't',
};

describe('loadScrapeConfig', () => {
  it('reads the required values and defaults the preview limits', () => {
    expect(loadScrapeConfig(base)).toMatchObject({
      scrapeQueueUrl: 'q',
      previewLimits: { maxPages: 2, maxItems: 20 },
      runConsumers: false,
    });
  });

  it.each(Object.keys(base))('fails fast without %s', (name) => {
    const env = { ...base, [name]: undefined };
    expect(() => loadScrapeConfig(env)).toThrow(
      new RegExp(`${name} is not set`),
    );
  });

  it('rejects an invalid preview limit', () => {
    expect(() => loadScrapeConfig({ ...base, PREVIEW_MAX_PAGES: '0' })).toThrow(
      /PREVIEW_MAX_PAGES/,
    );
  });
});
