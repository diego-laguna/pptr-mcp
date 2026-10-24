import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryObjectStore,
  LocalFileObjectStore,
} from '../storage/object-store.js';
import { specKey } from '../storage/keys.js';
import { InvalidSpecError } from './spec-validator.js';
import { validSpec } from './spec-fixtures.js';
import {
  SpecAlreadyExistsError,
  SpecNotFoundError,
  SpecStore,
} from './spec-store.js';

describe.each([
  [
    'in memory',
    () => ({ objects: new InMemoryObjectStore(), cleanup: async () => {} }),
  ],
  [
    'local files',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'specs-'));
      return {
        objects: new LocalFileObjectStore(dir),
        cleanup: () => rm(dir, { recursive: true }),
      };
    },
  ],
])('SpecStore (%s)', (_name, make) => {
  const key = specKey('c1', 's1', 1);

  it('loads a stored version', async () => {
    const { objects, cleanup } = await make();
    const store = new SpecStore(objects);
    await store.store(key, validSpec() as never);
    expect((await store.load(key)).site.url).toBe('https://shop.example/kids');
    await cleanup();
  });

  it('reports a missing version as not found', async () => {
    const { objects, cleanup } = await make();
    await expect(new SpecStore(objects).load(key)).rejects.toBeInstanceOf(
      SpecNotFoundError,
    );
    await cleanup();
  });

  it('rejects an invalid stored document', async () => {
    const { objects, cleanup } = await make();
    await objects.put(key, '{"formatVersion": 9}');
    await expect(new SpecStore(objects).load(key)).rejects.toBeInstanceOf(
      InvalidSpecError,
    );
    await cleanup();
  });

  it('refuses to overwrite a version with different content', async () => {
    const { objects, cleanup } = await make();
    const store = new SpecStore(objects);
    await store.store(key, validSpec() as never);
    await store.store(key, validSpec() as never); // identical: no-op
    const changed = validSpec();
    changed.items.locator = { css: '.other' };
    await expect(store.store(key, changed as never)).rejects.toBeInstanceOf(
      SpecAlreadyExistsError,
    );
    expect((await store.load(key)).items.locator).toEqual({ css: '.product' });
    await cleanup();
  });
});
