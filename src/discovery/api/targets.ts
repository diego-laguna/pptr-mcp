import {
  SYSTEM_FIELDS,
  SelectorSpec,
} from '../../scrape/spec/selector-spec.js';
import { DiscoveryMode, SchemaSnapshot } from './types.js';

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

/** Schema properties a spec binds; the variant property counts when variants are bound. */
export function boundProperties(
  spec: SelectorSpec,
  snapshot: SchemaSnapshot,
): string[] {
  const bound = Object.keys(spec.properties);
  if (spec.variants && snapshot.variantProperty)
    bound.push(snapshot.variantProperty);
  return bound;
}

/**
 * Chooses the properties an attempt aims at.
 * - full: none are named; the whole schema is in scope.
 * - incremental: only properties the base does not bind (all of them by default).
 * - repair: only properties the base binds (those the latest scrape reported failing by default).
 * Throws TargetError, which the endpoint answers with 422.
 */
export function resolveTargets(input: {
  mode: DiscoveryMode;
  requested: string[] | undefined;
  snapshot: SchemaSnapshot;
  base: SelectorSpec | null;
  failingFromLastScrape: string[];
}): string[] {
  const { mode, requested, snapshot, base } = input;
  const declared = new Set(snapshot.properties.map((p) => p.name));

  if (mode === 'full') {
    if (requested && requested.length > 0)
      throw new TargetError('a full discovery does not take target properties');
    return [];
  }
  if (!base) throw new TargetError('a base spec is required');

  const bound = new Set(boundProperties(base, snapshot));
  const unique = requested ? [...new Set(requested)] : undefined;

  for (const name of unique ?? []) {
    if ((SYSTEM_FIELDS as readonly string[]).includes(name))
      throw new TargetError(
        `${name} is a system field; use a full discovery if system fields stopped working`,
      );
    if (!declared.has(name))
      throw new TargetError(`${name} is not a property of the catalog schema`);
  }

  if (mode === 'incremental') {
    const alreadyBound = (unique ?? []).filter((n) => bound.has(n));
    if (alreadyBound.length > 0)
      throw new TargetError(
        `already bound by the base spec: ${alreadyBound.join(', ')}`,
      );
    const targets = unique?.length
      ? unique
      : snapshot.properties.map((p) => p.name).filter((n) => !bound.has(n));
    if (targets.length === 0)
      throw new TargetError('every property is already bound');
    return targets;
  }

  const notBound = (unique ?? []).filter((n) => !bound.has(n));
  if (notBound.length > 0)
    throw new TargetError(
      `not bound by the active spec: ${notBound.join(', ')}`,
    );
  const targets = unique?.length
    ? unique
    : input.failingFromLastScrape.filter((n) => bound.has(n));
  if (targets.length === 0)
    throw new TargetError(
      'no failing properties are known; name the properties to repair',
    );
  return targets;
}
