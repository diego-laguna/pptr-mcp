import { readFile } from 'node:fs/promises';
import { parseSchema } from '../../catalog/schema/schema-validator.js';
import type { CatalogSchema } from '../../catalog/schema/property-types.js';
import { SelectorSpec } from '../../scrape/spec/selector-spec.js';
import {
  InvalidSpecError,
  validateSelectorSpec,
} from '../../scrape/spec/spec-validator.js';
import { snapshotFromSchema } from '../api/snapshot.js';
import { resolveTargets, TargetError } from '../api/targets.js';
import { SchemaSnapshot } from '../api/types.js';
import { LocalOptions } from './args.js';

export class InputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'InputError';
  }
}

export interface LoadedInputs {
  schema: CatalogSchema;
  snapshot: SchemaSnapshot;
  base: SelectorSpec | null;
  targets: string[];
}

async function readJson(file: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new InputError([`${what} file ${file} could not be read`]);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError([`${what} file ${file} is not valid JSON`]);
  }
}

/** Everything that can be checked without a browser or a model, failing with named problems. */
export async function loadInputs(options: LocalOptions): Promise<LoadedInputs> {
  const parsed = parseSchema(await readJson(options.schemaFile, 'schema'));
  if (!parsed.ok)
    throw new InputError(
      parsed.issues.map((i) => `schema ${i.path}: ${i.message}`),
    );
  const snapshot = snapshotFromSchema(parsed.schema, options.schemaVersion);

  let base: SelectorSpec | null = null;
  if (options.baseFile) {
    const raw = await readJson(options.baseFile, 'base spec');
    try {
      base = validateSelectorSpec(raw);
    } catch (error) {
      if (error instanceof InvalidSpecError)
        throw new InputError(
          error.issues.map((i) => `base spec ${i.path}: ${i.message}`),
        );
      throw error;
    }
  }

  let targets: string[];
  try {
    targets = resolveTargets({
      mode: options.mode,
      requested: options.properties.length ? options.properties : undefined,
      snapshot,
      base,
      failingFromLastScrape: [],
    });
  } catch (error) {
    if (error instanceof TargetError) throw new InputError([error.message]);
    throw error;
  }
  return { schema: parsed.schema, snapshot, base, targets };
}
