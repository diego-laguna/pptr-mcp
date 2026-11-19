import { isIsoCalendarDate } from '../../catalog/schema/property-types.js';
import { Transform } from '../spec/selector-spec.js';

export type TransformResult =
  { ok: true; value: unknown } | { ok: false; message: string };

const fail = (message: string): TransformResult => ({ ok: false, message });

/** Runs the ordered chain on raw text; the first failure stops it. */
export function applyTransforms(
  raw: string | null,
  chain: Transform[] | undefined,
): TransformResult {
  if (raw === null) return fail('no raw value');
  let current: unknown = raw;
  for (const transform of chain ?? []) {
    const result = applyOne(current, transform);
    if (!result.ok) return result;
    current = result.value;
  }
  return { ok: true, value: current };
}

function applyOne(input: unknown, t: Transform): TransformResult {
  if (typeof input !== 'string')
    return fail(`${t.type} expects text but got ${typeof input}`);
  switch (t.type) {
    case 'trim':
      return { ok: true, value: input.trim() };
    case 'regex': {
      const match = new RegExp(t.pattern).exec(input);
      const captured =
        match?.[(t.group ?? 1 in (match ?? [])) ? (t.group ?? 1) : 0];
      return match && captured !== undefined
        ? { ok: true, value: captured }
        : fail(`"${input}" does not match /${t.pattern}/`);
    }
    case 'number':
      return parseNumber(input, t.locale);
    case 'date':
      return parseDate(input, t.format, t.locale ?? 'en');
    case 'enum_map': {
      const key = input.trim().toLowerCase();
      for (const [from, to] of Object.entries(t.map))
        if (from.toLowerCase() === key) return { ok: true, value: to };
      return fail(`"${input}" is not in the enum map`);
    }
    case 'boolean_map': {
      const key = input.trim().toLowerCase();
      if (t.true.some((v) => v.toLowerCase() === key))
        return { ok: true, value: true };
      if (t.false.some((v) => v.toLowerCase() === key))
        return { ok: true, value: false };
      return fail(`"${input}" is not in the boolean map`);
    }
    case 'split':
      return {
        ok: true,
        value: input
          .split(t.separator)
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      };
  }
}

function numberSeparators(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  return {
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
  };
}

function parseNumber(input: string, locale: string): TransformResult {
  let separators;
  try {
    separators = numberSeparators(locale);
  } catch {
    return fail(`unsupported locale "${locale}"`);
  }
  // Currency symbols and codes fall away; any other letter means this is not a number.
  const stripped = input.replace(
    /US\$|U\$S|\b(?:ARS|USD|EUR|BRL|CLP|UYU)\b|[$€£¥]/gi,
    '',
  );
  if (/[a-z]/i.test(stripped))
    return fail(`"${input}" is not a number in ${locale}`);
  const kept = stripped.replace(/[^\d.,'\u00a0\u202f\s-]/g, '');
  const sign = /^\s*-/.test(stripped) ? -1 : 1;
  const group = separators.group.replace(/[  ]/, ' ');
  let text = kept.replace(/[  ]/g, ' ').replace(/-/g, '');
  text = text.split(group).join('').replace(/\s/g, '');
  text = text.split(separators.decimal).join('.');
  if (!/^\d+(\.\d+)?$/.test(text))
    return fail(`"${input}" is not a number in ${locale}`);
  return { ok: true, value: sign * Number(text) };
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ.]/g, '').toLowerCase();
}

function monthNames(locale: string, style: 'long' | 'short'): string[] {
  const fmt = new Intl.DateTimeFormat(locale, {
    month: style,
    timeZone: 'UTC',
  });
  return Array.from({ length: 12 }, (_, m) =>
    normalize(fmt.format(new Date(Date.UTC(2024, m, 1)))),
  );
}

function parseDate(
  input: string,
  format: string,
  locale: string,
): TransformResult {
  let longNames: string[];
  let shortNames: string[];
  try {
    longNames = monthNames(locale, 'long');
    shortNames = monthNames(locale, 'short');
  } catch {
    return fail(`unsupported locale "${locale}"`);
  }
  const order: ('y' | 'M' | 'd' | 'Mname')[] = [];
  const names = [...longNames, ...shortNames].sort(
    (a, b) => b.length - a.length,
  );
  let pattern = '';
  const tokens = /'[^']*'|yyyy|yy|MMMM|MMM|MM|M|dd|d|[^yMd']+/g;
  for (const token of format.match(tokens) ?? []) {
    switch (token) {
      case 'yyyy':
        pattern += '(\\d{4})';
        order.push('y');
        break;
      case 'yy':
        pattern += '(\\d{2})';
        order.push('y');
        break;
      case 'MM':
      case 'M':
        pattern += '(\\d{1,2})';
        order.push('M');
        break;
      case 'MMM':
      case 'MMMM':
        pattern += `(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        order.push('Mname');
        break;
      case 'dd':
      case 'd':
        pattern += '(\\d{1,2})';
        order.push('d');
        break;
      default:
        pattern += token
          .replace(/^'|'$/g, '')
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const match = new RegExp(`^${pattern}$`).exec(normalize(input).trim());
  if (!match) return fail(`"${input}" does not match date format ${format}`);
  let year = 0;
  let month = 0;
  let day = 0;
  order.forEach((kind, i) => {
    const part = match[i + 1];
    if (kind === 'y')
      year = part.length === 2 ? 2000 + Number(part) : Number(part);
    else if (kind === 'M') month = Number(part);
    else if (kind === 'd') day = Number(part);
    else {
      const idx = longNames.indexOf(part);
      month = (idx >= 0 ? idx : shortNames.indexOf(part)) + 1;
    }
  });
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoCalendarDate(iso)
    ? { ok: true, value: iso }
    : fail(`"${input}" is not a real date`);
}
