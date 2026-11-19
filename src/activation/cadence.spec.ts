import {
  assertCadenceAllowed,
  InvalidCadenceError,
  parseCadence,
  smallestIntervalMinutes,
} from './cadence.js';

const now = new Date('2026-10-24T12:00:00Z');
const allowed = (expression: string, min = 60) =>
  assertCadenceAllowed(parseCadence({ expression }), min, now);

describe('parseCadence', () => {
  it('defaults the timezone to UTC and validates named ones', () => {
    expect(parseCadence({ expression: ' rate(1 day) ' })).toEqual({
      expression: 'rate(1 day)',
      timezone: 'UTC',
    });
    expect(
      parseCadence({
        expression: 'rate(1 day)',
        timezone: 'America/Argentina/Buenos_Aires',
      }).timezone,
    ).toBe('America/Argentina/Buenos_Aires');
    expect(() =>
      parseCadence({ expression: 'rate(1 day)', timezone: 'Mars/Base' }),
    ).toThrow(InvalidCadenceError);
    expect(() => parseCadence({})).toThrow(InvalidCadenceError);
  });
});

describe('minimum interval', () => {
  it.each([
    ['rate(1 day)', 1440],
    ['rate(6 hours)', 360],
    ['rate(1 hour)', 60],
    ['rate(90 minutes)', 90],
    ['cron(0 8 * * ? *)', 1440],
    ['cron(0 */6 * * ? *)', 360],
    ['cron(0 8 ? * MON-FRI *)', 1440],
    ['cron(30 9 1 * ? *)', 28 * 1440],
  ])('measures %s', (expression, minutes) => {
    const measured = smallestIntervalMinutes(expression, now);
    if (expression === 'cron(30 9 1 * ? *)')
      expect(measured).toBeGreaterThanOrEqual(28 * 1440);
    else if (expression === 'cron(0 8 ? * MON-FRI *)')
      expect(measured).toBe(1440);
    else expect(measured).toBe(minutes);
  });

  it('accepts cadences at or above the minimum', () => {
    expect(() => allowed('rate(1 hour)')).not.toThrow();
    expect(() => allowed('rate(1 day)')).not.toThrow();
    expect(() => allowed('cron(0 8 * * ? *)')).not.toThrow();
    expect(() => allowed('rate(30 minutes)', 30)).not.toThrow();
  });

  it.each([
    'rate(5 minutes)',
    'rate(59 minutes)',
    'cron(0/5 * * * ? *)',
    'cron(0,30 * * * ? *)',
  ])('rejects %s as too frequent', (expression) => {
    expect(() => allowed(expression)).toThrow(/minimum interval/);
  });

  it.each([
    'every day',
    'rate(0 hours)',
    'rate(1 hours)',
    'rate(2 hour)',
    'rate(1 fortnight)',
    'cron(0 8 * * *)',
    'cron(0 8 * * * *)',
    'cron(61 8 ? * * *)',
    'cron(0 8 15W * ? *)',
    'cron(0 8 ? * ? *)',
    'cron(0 8 1 * MON *)',
    'at(2026-10-25T00:00:00)',
  ])('rejects the invalid expression %s', (expression) => {
    expect(() => allowed(expression)).toThrow(InvalidCadenceError);
  });
});
