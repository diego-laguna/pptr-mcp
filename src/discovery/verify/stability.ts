import {
  Binding,
  Locator,
  SelectorSpec,
  SYSTEM_FIELDS,
} from '../../scrape/spec/selector-spec.js';

export interface StabilityWarning {
  binding: string;
  locator: string;
  reason: 'positional' | 'long_absolute_path' | 'generated_class_name';
}

const GENERATED_CLASS =
  /^(?:css|sc|jsx|styled|emotion|svelte|_)[-_]?[a-z0-9]{5,}$/i;
const looksHashed = (token: string) =>
  token.length >= 7 &&
  /\d/.test(token) &&
  /[a-z]/i.test(token) &&
  /^[a-z0-9_-]+$/i.test(token) &&
  !/^[a-z]+-[a-z]+(-[a-z]+)*$/i.test(token);

function reasonsFor(locator: Locator): StabilityWarning['reason'][] {
  const reasons: StabilityWarning['reason'][] = [];
  if ('css' in locator) {
    const css = locator.css;
    if (
      /:nth-(?:child|of-type|last-child|last-of-type)\(/.test(css) ||
      /:(?:first|last)-child/.test(css)
    )
      reasons.push('positional');
    if (css.split('>').length > 6) reasons.push('long_absolute_path');
    const classes = [...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
    if (
      classes.some(
        (c) =>
          GENERATED_CLASS.test(c) ||
          (looksHashed(c) && /[a-z]\d|\d[a-z]/i.test(c)),
      )
    )
      reasons.push('generated_class_name');
  } else {
    const xp = locator.xpath;
    if (/\[\d+\]/.test(xp) || /\[position\(\)/.test(xp))
      reasons.push('positional');
    if (xp.startsWith('/html') || xp.split('/').filter(Boolean).length > 6)
      reasons.push('long_absolute_path');
    const classes = [
      ...xp.matchAll(
        /@class\s*=\s*['"]([^'"]+)['"]|contains\(@class,\s*['"]([^'"]+)['"]\)/g,
      ),
    ].flatMap((m) => (m[1] ?? m[2]).split(/\s+/));
    if (classes.some((c) => GENERATED_CLASS.test(c)))
      reasons.push('generated_class_name');
  }
  return reasons;
}

const text = (l: Locator) => ('css' in l ? l.css : l.xpath);

/** Advisory only: fragile locators are reported, never rejected. */
export function detectStability(spec: SelectorSpec): StabilityWarning[] {
  const warnings: StabilityWarning[] = [];
  const check = (name: string, locator?: Locator) => {
    if (!locator) return;
    for (const reason of reasonsFor(locator))
      warnings.push({ binding: name, locator: text(locator), reason });
  };
  const bindings: [string, Binding][] = [
    ...SYSTEM_FIELDS.map((f) => [f, spec.system[f]] as [string, Binding]),
    ...Object.entries(spec.properties),
  ];
  check('items', spec.items.locator);
  for (const [name, b] of bindings) check(name, b.locator);
  if (spec.variants) {
    check('variants', spec.variants.locator);
    for (const k of ['value', 'price', 'available'] as const)
      check(`variants.${k}`, spec.variants[k].locator);
  }
  return warnings;
}
