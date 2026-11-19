/**
 * A customer's cadence: an EventBridge Scheduler `rate(...)` or `cron(...)`
 * expression with an optional IANA timezone. Validation also enforces the
 * operator's minimum interval by sampling upcoming firing times.
 */
export interface Cadence {
  expression: string;
  timezone: string;
}

export class InvalidCadenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCadenceError';
  }
}

export const DEFAULT_MIN_INTERVAL_MINUTES = 60;
const SAMPLES = 24;

const UNIT_MINUTES: Record<string, number> = {
  minute: 1,
  minutes: 1,
  hour: 60,
  hours: 60,
  day: 1440,
  days: 1440,
};

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']; // AWS: 1 = SUN

export function parseCadence(input: {
  expression?: unknown;
  timezone?: unknown;
}): Cadence {
  if (typeof input.expression !== 'string' || input.expression.trim() === '')
    throw new InvalidCadenceError('the cadence needs an expression');
  const timezone =
    input.timezone === undefined || input.timezone === ''
      ? 'UTC'
      : input.timezone;
  if (typeof timezone !== 'string')
    throw new InvalidCadenceError('the timezone must be text');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new InvalidCadenceError(`unknown timezone "${timezone}"`);
  }
  return { expression: input.expression.trim(), timezone };
}

/** Throws InvalidCadenceError unless the expression parses and fires no more often than the minimum. */
export function assertCadenceAllowed(
  cadence: Cadence,
  minIntervalMinutes: number = DEFAULT_MIN_INTERVAL_MINUTES,
  from: Date = new Date(),
): void {
  const interval = smallestIntervalMinutes(cadence.expression, from);
  if (interval < minIntervalMinutes)
    throw new InvalidCadenceError(
      `the cadence runs every ${interval} minute(s); the minimum interval is ${minIntervalMinutes} minutes`,
    );
}

export function smallestIntervalMinutes(
  expression: string,
  from: Date,
): number {
  const rate = /^rate\(\s*(\d+)\s+([a-z]+)\s*\)$/i.exec(expression.trim());
  if (rate) {
    const unit = UNIT_MINUTES[rate[2].toLowerCase()];
    const n = Number(rate[1]);
    if (!unit || n < 1)
      throw new InvalidCadenceError(`invalid rate expression "${expression}"`);
    if (n === 1 && rate[2].toLowerCase().endsWith('s'))
      throw new InvalidCadenceError(
        'use the singular unit when the value is 1, for example rate(1 hour)',
      );
    if (n > 1 && !rate[2].toLowerCase().endsWith('s'))
      throw new InvalidCadenceError(
        'use the plural unit when the value is more than 1, for example rate(2 hours)',
      );
    return n * unit;
  }
  const cron = /^cron\(\s*(.+?)\s*\)$/i.exec(expression.trim());
  if (!cron)
    throw new InvalidCadenceError(
      'the expression must be rate(...) or cron(...)',
    );
  const firings = nextCronFirings(cron[1], from, SAMPLES);
  if (firings.length < 2) return Number.POSITIVE_INFINITY; // at most once in the sampled window
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < firings.length; i++)
    min = Math.min(
      min,
      (firings[i].getTime() - firings[i - 1].getTime()) / 60_000,
    );
  return min;
}

type FieldSpec = { values: Set<number> | 'any' };

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: string[],
  nameBase = 0,
): FieldSpec {
  if (raw === '*' || raw === '?') return { values: 'any' };
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1)
      throw new InvalidCadenceError(`invalid step in "${raw}"`);
    const num = (token: string) => {
      const idx = names?.indexOf(token.toUpperCase()) ?? -1;
      const n = idx >= 0 ? idx + nameBase : Number(token);
      if (!Number.isInteger(n) || n < min || n > max)
        throw new InvalidCadenceError(
          `"${token}" is out of range ${min}-${max}`,
        );
      return n;
    };
    let lo: number;
    let hi: number;
    if (rangePart === '*') [lo, hi] = [min, max];
    else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      [lo, hi] = [num(a), num(b)];
    } else {
      lo = num(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (lo > hi) throw new InvalidCadenceError(`invalid range "${rangePart}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values };
}

const matches = (f: FieldSpec, n: number) =>
  f.values === 'any' || f.values.has(n);

/** AWS six-field cron (minutes hours day-of-month month day-of-week year), evaluated in UTC; L, W and # are not supported. */
function nextCronFirings(body: string, from: Date, count: number): Date[] {
  const fields = body.split(/\s+/);
  if (fields.length !== 6)
    throw new InvalidCadenceError(
      'a cron expression needs 6 fields: minutes hours day-of-month month day-of-week year',
    );
  if (fields.some((f) => /[LW#]/i.test(f) && !/^[A-Za-z,-]+$/.test(f)))
    throw new InvalidCadenceError(
      'L, W and # are not supported in cron expressions here',
    );
  const [minF, hourF, domF, monF, dowF, yearF] = fields;
  if ((domF === '?') === (dowF === '?'))
    throw new InvalidCadenceError(
      'exactly one of day-of-month and day-of-week must be ?',
    );
  const minutes = parseField(minF, 0, 59);
  const hours = parseField(hourF, 0, 23);
  const dom = parseField(domF, 1, 31);
  const months = parseField(monF, 1, 12, MONTHS, 1);
  const dow = parseField(dowF, 1, 7, WEEKDAYS, 1);
  const years = parseField(yearF, 1970, 2199);

  const out: Date[] = [];
  const day = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  for (
    let d = 0;
    d < 800 && out.length < count;
    d++, day.setUTCDate(day.getUTCDate() + 1)
  ) {
    if (
      !matches(years, day.getUTCFullYear()) ||
      !matches(months, day.getUTCMonth() + 1)
    )
      continue;
    if (!matches(dom, day.getUTCDate()) || !matches(dow, day.getUTCDay() + 1))
      continue;
    for (let h = 0; h < 24; h++) {
      if (!matches(hours, h)) continue;
      for (let m = 0; m < 60; m++) {
        if (!matches(minutes, m)) continue;
        const at = new Date(
          Date.UTC(
            day.getUTCFullYear(),
            day.getUTCMonth(),
            day.getUTCDate(),
            h,
            m,
          ),
        );
        if (at > from) out.push(at);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}
