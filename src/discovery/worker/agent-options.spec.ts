import { DiscoveryMessage } from '../api/types.js';
import { buildSystemPrompt, SYSTEM_FIELD_GUIDE } from './agent-options.js';

function message(overrides: Partial<DiscoveryMessage> = {}): DiscoveryMessage {
  return {
    attemptId: 'a1',
    mode: 'full',
    customerId: 'c1',
    catalogId: 'cat1',
    siteId: 's1',
    siteUrl: 'https://shop.example/',
    snapshot: {
      schemaVersion: 1,
      variantProperty: null,
      properties: [
        {
          name: 'fabric',
          type: 'string',
          description: 'Main fabric',
          required: false,
        },
      ],
    },
    targetProperties: [],
    guidance: null,
    baseSpecKey: null,
    baseVersion: null,
    caps: { maxTurns: 15, maxMinutes: 5, maxCostUsd: 1 },
    outputPrefix: 'a1',
    ...overrides,
  } as DiscoveryMessage;
}

describe('buildSystemPrompt', () => {
  it('defines every system field so the agent knows what each one means', () => {
    const prompt = buildSystemPrompt(message());
    expect(prompt).toContain(SYSTEM_FIELD_GUIDE);
    for (const field of ['name', 'link', 'price', 'thumbnail_url']) {
      expect(SYSTEM_FIELD_GUIDE).toContain(`- ${field}:`);
    }
  });

  it('says the name is not the brand', () => {
    expect(buildSystemPrompt(message())).toMatch(/name:.*not the brand/);
  });

  it('keeps the schema properties and guidance in the prompt', () => {
    const prompt = buildSystemPrompt(
      message({ guidance: 'sizes are buttons' }),
    );
    expect(prompt).toContain('- fabric (string): Main fabric');
    expect(prompt).toContain('sizes are buttons');
  });
});
