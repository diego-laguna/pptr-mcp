import { ObjectStore } from '../storage/object-store.js';
import { SelectorSpec } from './selector-spec.js';
import { validateSelectorSpec } from './spec-validator.js';

export class SpecNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`spec not found: ${key}`);
    this.name = 'SpecNotFoundError';
  }
}

export class SpecAlreadyExistsError extends Error {
  constructor(readonly key: string) {
    super(`spec version already stored with different content: ${key}`);
    this.name = 'SpecAlreadyExistsError';
  }
}

/** Immutable, versioned selector specs. */
export class SpecStore {
  constructor(private readonly objects: ObjectStore) {}

  /** Loads and validates; throws SpecNotFoundError or InvalidSpecError. */
  async load(key: string): Promise<SelectorSpec> {
    const body = await this.objects.get(key);
    if (body === null) throw new SpecNotFoundError(key);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    return validateSelectorSpec(parsed);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.objects.get(key)) !== null;
  }

  /** Stores a new version; re-storing identical content is a no-op, different content is rejected. */
  async store(key: string, spec: SelectorSpec): Promise<void> {
    validateSelectorSpec(spec);
    const body = JSON.stringify(spec);
    if (await this.objects.putIfAbsent(key, body)) return;
    const existing = await this.objects.get(key);
    if (existing !== null && canonical(existing) === canonical(body)) return;
    throw new SpecAlreadyExistsError(key);
  }
}

function canonical(json: string): string {
  return JSON.stringify(sortKeys(JSON.parse(json)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
