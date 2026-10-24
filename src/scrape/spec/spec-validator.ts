import { parse as parseCss } from 'css-what';
import xpath from 'xpath';
import {
  SelectorSpec,
  SPEC_FORMAT_VERSION,
  SYSTEM_FIELDS,
} from './selector-spec.js';

export interface SpecIssue {
  path: string;
  message: string;
}

export class InvalidSpecError extends Error {
  constructor(readonly issues: SpecIssue[]) {
    super(
      `invalid selector spec: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
    this.name = 'InvalidSpecError';
  }
}

const MAX_PAGES = 200;
const MAX_REGEX_LENGTH = 200;
const STEP_TYPES = ['open_url', 'click', 'wait_for', 'scroll'];
const TRANSFORM_TYPES = [
  'trim',
  'regex',
  'number',
  'date',
  'enum_map',
  'boolean_map',
  'split',
];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

class Checker {
  readonly issues: SpecIssue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  /** The vocabulary is closed: any key that is not listed is rejected, which also keeps code-bearing fields out. */
  keys(value: Obj, allowed: string[], path: string): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.add(`${path}.${key}`, 'unknown field');
    }
  }

  url(value: unknown, path: string, placeholder = false): void {
    if (typeof value !== 'string') return this.add(path, 'must be a string');
    if (placeholder && !value.includes('{page}'))
      return this.add(path, 'must contain {page}');
    try {
      const u = new URL(value.replace('{page}', '1'));
      if (u.protocol !== 'http:' && u.protocol !== 'https:')
        this.add(path, 'must be an http(s) URL');
    } catch {
      this.add(path, 'must be an absolute URL');
    }
  }

  bound(value: unknown, path: string): void {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_PAGES
    ) {
      this.add(path, `must be an integer between 1 and ${MAX_PAGES}`);
    }
  }

  locator(value: unknown, path: string): void {
    if (!isObj(value)) return this.add(path, 'must be a locator object');
    const kinds = Object.keys(value);
    if (kinds.length !== 1 || (kinds[0] !== 'css' && kinds[0] !== 'xpath')) {
      return this.add(path, 'must hold exactly one of css or xpath');
    }
    const expr = value[kinds[0]];
    if (typeof expr !== 'string' || expr.trim() === '')
      return this.add(path, 'must be a non-empty string');
    try {
      if (kinds[0] === 'css') parseCss(expr);
      else (xpath as unknown as { parse(e: string): unknown }).parse(expr);
    } catch {
      this.add(path, `${kinds[0]} locator is syntactically invalid`);
    }
  }

  binding(value: unknown, path: string, locatorRequired = false): void {
    if (!isObj(value)) return this.add(path, 'must be a binding object');
    this.keys(value, ['locator', 'source', 'transforms'], path);
    if (value.locator !== undefined)
      this.locator(value.locator, `${path}.locator`);
    else if (locatorRequired) this.add(`${path}.locator`, 'is required');
    const source = value.source;
    const okSource =
      source === 'text' ||
      (isObj(source) &&
        Object.keys(source).length === 1 &&
        typeof source.attribute === 'string' &&
        source.attribute !== '');
    if (!okSource) this.add(`${path}.source`, 'must be "text" or {attribute}');
    if (value.transforms !== undefined) {
      if (!Array.isArray(value.transforms))
        this.add(`${path}.transforms`, 'must be an array');
      else
        value.transforms.forEach((t, i) =>
          this.transform(t, `${path}.transforms[${i}]`),
        );
    }
  }

  transform(value: unknown, path: string): void {
    if (!isObj(value) || typeof value.type !== 'string')
      return this.add(path, 'must have a type');
    if (!TRANSFORM_TYPES.includes(value.type))
      return this.add(`${path}.type`, `unknown transform "${value.type}"`);
    const str = (k: string) =>
      typeof value[k] === 'string' && (value[k] as string) !== ''
        ? true
        : (this.add(`${path}.${k}`, 'must be a non-empty string'), false);
    switch (value.type) {
      case 'trim':
        this.keys(value, ['type'], path);
        break;
      case 'regex': {
        this.keys(value, ['type', 'pattern', 'group'], path);
        if (str('pattern')) {
          const pattern = value.pattern as string;
          if (pattern.length > MAX_REGEX_LENGTH)
            this.add(`${path}.pattern`, 'is too long');
          else {
            try {
              new RegExp(pattern);
            } catch {
              this.add(`${path}.pattern`, 'is not a valid regular expression');
            }
          }
        }
        if (
          value.group !== undefined &&
          (!Number.isInteger(value.group) || (value.group as number) < 0)
        )
          this.add(`${path}.group`, 'must be a non-negative integer');
        break;
      }
      case 'number':
        this.keys(value, ['type', 'locale'], path);
        str('locale');
        break;
      case 'date':
        this.keys(value, ['type', 'format', 'locale'], path);
        str('format');
        if (value.locale !== undefined) str('locale');
        break;
      case 'enum_map':
        this.keys(value, ['type', 'map'], path);
        if (
          !isObj(value.map) ||
          !Object.values(value.map).every((v) => typeof v === 'string')
        )
          this.add(`${path}.map`, 'must map strings to strings');
        break;
      case 'boolean_map': {
        this.keys(value, ['type', 'true', 'false'], path);
        for (const k of ['true', 'false']) {
          const list = value[k];
          if (!Array.isArray(list) || !list.every((v) => typeof v === 'string'))
            this.add(`${path}.${k}`, 'must be a list of strings');
        }
        break;
      }
      case 'split':
        this.keys(value, ['type', 'separator'], path);
        str('separator');
        break;
    }
  }

  step(value: unknown, path: string): void {
    if (!isObj(value) || typeof value.type !== 'string')
      return this.add(path, 'must have a type');
    if (!STEP_TYPES.includes(value.type))
      return this.add(`${path}.type`, `unknown step type "${value.type}"`);
    switch (value.type) {
      case 'open_url':
        this.keys(value, ['type', 'url'], path);
        this.url(value.url, `${path}.url`);
        break;
      case 'click':
        this.keys(value, ['type', 'locator'], path);
        this.locator(value.locator, `${path}.locator`);
        break;
      case 'wait_for':
        this.keys(value, ['type', 'locator', 'timeoutMs'], path);
        this.locator(value.locator, `${path}.locator`);
        break;
      case 'scroll':
        this.keys(value, ['type', 'times'], path);
        if (value.times !== undefined) this.bound(value.times, `${path}.times`);
        break;
    }
  }

  pagination(value: unknown, path: string): void {
    if (!isObj(value)) return this.add(path, 'must be an object');
    switch (value.mode) {
      case 'next_button':
        this.keys(value, ['mode', 'locator', 'maxPages'], path);
        this.locator(value.locator, `${path}.locator`);
        break;
      case 'url_template':
        this.keys(value, ['mode', 'template', 'startPage', 'maxPages'], path);
        this.url(value.template, `${path}.template`, true);
        if (!Number.isInteger(value.startPage))
          this.add(`${path}.startPage`, 'must be an integer');
        break;
      case 'infinite_scroll':
        this.keys(value, ['mode', 'maxScrolls', 'maxPages'], path);
        this.bound(value.maxScrolls, `${path}.maxScrolls`);
        break;
      default:
        return this.add(`${path}.mode`, 'unknown pagination mode');
    }
    this.bound(value.maxPages, `${path}.maxPages`);
  }
}

/** Validates an untrusted document; throws InvalidSpecError listing every problem. */
export function validateSelectorSpec(input: unknown): SelectorSpec {
  const c = new Checker();
  if (!isObj(input))
    throw new InvalidSpecError([{ path: '$', message: 'must be an object' }]);
  c.keys(
    input,
    [
      'formatVersion',
      'site',
      'steps',
      'pagination',
      'items',
      'system',
      'properties',
      'variants',
    ],
    '$',
  );
  if (input.formatVersion !== SPEC_FORMAT_VERSION)
    c.add('$.formatVersion', `unsupported (supported: ${SPEC_FORMAT_VERSION})`);

  if (!isObj(input.site)) c.add('$.site', 'is required');
  else {
    c.keys(input.site, ['url'], '$.site');
    c.url(input.site.url, '$.site.url');
  }

  if (!Array.isArray(input.steps)) c.add('$.steps', 'must be an array');
  else input.steps.forEach((s, i) => c.step(s, `$.steps[${i}]`));

  if (input.pagination !== undefined)
    c.pagination(input.pagination, '$.pagination');

  if (!isObj(input.items)) c.add('$.items', 'is required');
  else {
    c.keys(input.items, ['locator'], '$.items');
    c.locator(input.items.locator, '$.items.locator');
  }

  if (!isObj(input.system)) c.add('$.system', 'is required');
  else {
    c.keys(input.system, [...SYSTEM_FIELDS], '$.system');
    for (const field of SYSTEM_FIELDS) {
      if (input.system[field] === undefined)
        c.add(`$.system.${field}`, 'binding is required');
      else c.binding(input.system[field], `$.system.${field}`);
    }
  }

  if (!isObj(input.properties)) c.add('$.properties', 'must be an object');
  else
    for (const [name, b] of Object.entries(input.properties))
      c.binding(b, `$.properties.${name}`);

  if (input.variants !== undefined) {
    const v = input.variants;
    if (!isObj(v)) c.add('$.variants', 'must be an object');
    else {
      c.keys(v, ['locator', 'value', 'price', 'available'], '$.variants');
      c.locator(v.locator, '$.variants.locator');
      for (const k of ['value', 'price', 'available'])
        c.binding(v[k], `$.variants.${k}`);
    }
  }

  if (c.issues.length > 0) throw new InvalidSpecError(c.issues);
  return input as unknown as SelectorSpec;
}
