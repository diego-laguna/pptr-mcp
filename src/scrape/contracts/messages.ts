export const SCRAPE_MODES = ['production', 'preview'] as const;
export type ScrapeMode = (typeof SCRAPE_MODES)[number];

export const FAILURE_REASONS = [
  'no_spec',
  'invalid_spec',
  'schema_mismatch',
  'timeout',
  'count_anomaly',
  'parse_anomaly',
  'stale_schema',
  'error',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** Reasons that repeating the run cannot fix; they are reported, never retried. */
export const DETERMINISTIC_REASONS: readonly FailureReason[] = [
  'no_spec',
  'invalid_spec',
  'schema_mismatch',
  'timeout',
  'count_anomaly',
  'parse_anomaly',
  'stale_schema',
];

export interface PreviewLimits {
  maxPages: number;
  maxItems: number;
}

export interface SchemaShape {
  properties: string[];
  variantProperty: string | null;
}

/** Everything the stateless worker needs; it has no database access. */
export interface ScrapeMessage {
  runId: string;
  mode: ScrapeMode;
  customerId: string;
  catalogId: string;
  siteId: string;
  specKey: string;
  specVersion: number;
  schemaVersion: number;
  /** The pinned schema's shape, so the worker can check the spec without database access. */
  schema: SchemaShape;
  /** Present on previews only. */
  limits?: PreviewLimits;
}

export interface RunStats {
  items: number;
  pages: number;
  durationMs: number;
}

export interface FinishedMessage {
  runId: string;
  outcome: 'succeeded' | 'failed';
  reason?: FailureReason;
  /** Reference to the stored result; the result itself never travels on the queue. */
  resultKey?: string;
  stats?: RunStats;
  detail?: string;
}

/** Published for failed production runs. */
export interface FailedScrapeEvent {
  runId: string;
  siteId: string;
  catalogId: string;
  customerId: string;
  reason: FailureReason;
  detail?: string;
}

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function str(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '')
    throw new InvalidMessageError(`${key} must be a non-empty string`);
  return v;
}

function posInt(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    throw new InvalidMessageError(`${key} must be a positive integer`);
  return v;
}

function parseSchemaShape(input: unknown): SchemaShape {
  if (!isObj(input)) throw new InvalidMessageError('schema is required');
  const { properties, variantProperty } = input;
  if (
    !Array.isArray(properties) ||
    !properties.every((p) => typeof p === 'string')
  )
    throw new InvalidMessageError('schema.properties must be a list of names');
  if (variantProperty !== null && typeof variantProperty !== 'string')
    throw new InvalidMessageError(
      'schema.variantProperty must be a name or null',
    );
  return { properties, variantProperty };
}

export function parseScrapeMessage(input: unknown): ScrapeMessage {
  if (!isObj(input)) throw new InvalidMessageError('message must be an object');
  const mode = input.mode;
  if (mode !== 'production' && mode !== 'preview')
    throw new InvalidMessageError('mode must be production or preview');
  const message: ScrapeMessage = {
    runId: str(input, 'runId'),
    mode,
    customerId: str(input, 'customerId'),
    catalogId: str(input, 'catalogId'),
    siteId: str(input, 'siteId'),
    specKey: str(input, 'specKey'),
    specVersion: posInt(input, 'specVersion'),
    schemaVersion: posInt(input, 'schemaVersion'),
    schema: parseSchemaShape(input.schema),
  };
  if (mode === 'preview') {
    if (!isObj(input.limits))
      throw new InvalidMessageError('limits are required for a preview');
    message.limits = {
      maxPages: posInt(input.limits, 'maxPages'),
      maxItems: posInt(input.limits, 'maxItems'),
    };
  } else if (input.limits !== undefined) {
    throw new InvalidMessageError('limits are only allowed on a preview');
  }
  return message;
}

export function parseFinishedMessage(input: unknown): FinishedMessage {
  if (!isObj(input)) throw new InvalidMessageError('message must be an object');
  const outcome = input.outcome;
  if (outcome !== 'succeeded' && outcome !== 'failed')
    throw new InvalidMessageError('outcome must be succeeded or failed');
  const message: FinishedMessage = { runId: str(input, 'runId'), outcome };
  if (outcome === 'failed') {
    const reason = input.reason;
    if (!FAILURE_REASONS.includes(reason as FailureReason))
      throw new InvalidMessageError(
        `reason must be one of ${FAILURE_REASONS.join(', ')}`,
      );
    message.reason = reason as FailureReason;
  }
  if (input.resultKey !== undefined)
    message.resultKey = str(input, 'resultKey');
  else if (outcome === 'succeeded')
    throw new InvalidMessageError('a succeeded run needs a resultKey');
  if (input.stats !== undefined) {
    const s = input.stats;
    if (
      !isObj(s) ||
      ![s.items, s.pages, s.durationMs].every(
        (n) => typeof n === 'number' && n >= 0,
      )
    )
      throw new InvalidMessageError('stats must hold items, pages, durationMs');
    message.stats = s as unknown as RunStats;
  }
  if (typeof input.detail === 'string') message.detail = input.detail;
  return message;
}

export interface Issue {
  property: string;
  code: 'transform_failed' | 'missing';
  raw: string | null;
  message: string;
}

export interface ResultVariant {
  raw: Record<string, string | null>;
  value: { value?: string; price?: string; available?: boolean };
  issues: Issue[];
}

export interface ResultItem {
  raw: Record<string, string | null>;
  value: Record<string, unknown>;
  issues: Issue[];
  variants?: ResultVariant[];
}

/** Stored in object storage; reconciliation only ever reads `value`. */
export interface RunResult {
  runId: string;
  siteId: string;
  specVersion: number;
  schemaVersion: number;
  mode: ScrapeMode;
  finished: boolean;
  pages: number;
  /** Items dropped for lacking a name or link. */
  skipped: number;
  items: ResultItem[];
}
