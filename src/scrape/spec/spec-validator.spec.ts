import { InvalidSpecError, validateSelectorSpec } from './spec-validator.js';

import { validSpec } from './spec-fixtures.js';

const binding = (css: string) => ({
  locator: { css },
  source: 'text' as const,
});

const reasons = (spec: unknown) => {
  try {
    validateSelectorSpec(spec);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidSpecError);
    return (e as InvalidSpecError).issues.map((i) => `${i.path} ${i.message}`);
  }
};

describe('validateSelectorSpec', () => {
  it('accepts a valid spec', () => {
    expect(validateSelectorSpec(validSpec())).toBeTruthy();
  });

  it('accepts a spec with variants and every pagination mode', () => {
    const spec = validSpec();
    spec.variants = {
      locator: { css: '.size' },
      value: binding('span'),
      price: binding('.p'),
      available: {
        locator: { css: 'input' },
        source: { attribute: 'disabled' },
      },
    };
    for (const pagination of [
      {
        mode: 'url_template',
        template: 'https://s.example/?page={page}',
        startPage: 1,
        maxPages: 3,
      },
      { mode: 'infinite_scroll', maxScrolls: 4, maxPages: 4 },
    ]) {
      spec.pagination = pagination;
      expect(reasons(spec)).toEqual([]);
    }
  });

  it('rejects an unsupported format version', () => {
    const spec = validSpec();
    spec.formatVersion = 2;
    expect(reasons(spec).join()).toMatch(/formatVersion unsupported/);
  });

  it('rejects embedded code in any field', () => {
    const spec = validSpec();
    spec.system.name.script = 'return document.title';
    spec.onLoad = 'function () {}';
    const found = reasons(spec).join();
    expect(found).toMatch(/system\.name\.script unknown field/);
    expect(found).toMatch(/\$\.onLoad unknown field/);
  });

  it('rejects an unknown step type', () => {
    const spec = validSpec();
    spec.steps.push({ type: 'evaluate', code: '1' });
    expect(reasons(spec).join()).toMatch(/unknown step type "evaluate"/);
  });

  it('rejects pagination without a bound', () => {
    const spec = validSpec();
    delete spec.pagination.maxPages;
    expect(reasons(spec).join()).toMatch(/pagination\.maxPages/);
    spec.pagination.maxPages = 100000;
    expect(reasons(spec).join()).toMatch(/pagination\.maxPages/);
  });

  it('rejects a missing system field binding', () => {
    const spec = validSpec();
    delete spec.system.link;
    expect(reasons(spec).join()).toMatch(/system\.link binding is required/);
  });

  it('rejects malformed locators', () => {
    const spec = validSpec();
    spec.system.price.locator = { xpath: '//div[@class=' };
    spec.items.locator = { css: '.a >>> ' };
    const found = reasons(spec).join();
    expect(found).toMatch(
      /system\.price\.locator xpath locator is syntactically invalid/,
    );
    expect(found).toMatch(
      /items\.locator css locator is syntactically invalid/,
    );
  });

  it('rejects unknown transforms and bad regexes', () => {
    const spec = validSpec();
    spec.properties.launch.transforms = [
      { type: 'eval', expression: '1' },
      { type: 'regex', pattern: '(' },
    ];
    const found = reasons(spec).join();
    expect(found).toMatch(/unknown transform "eval"/);
    expect(found).toMatch(/pattern is not a valid regular expression/);
  });

  it('rejects a non-object document', () => {
    expect(reasons('spec')).toHaveLength(1);
  });
});
