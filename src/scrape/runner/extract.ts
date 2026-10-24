import { Issue, ResultItem, ResultVariant } from '../contracts/messages.js';
import {
  Binding,
  Locator,
  SelectorSpec,
  SYSTEM_FIELDS,
  VariantBindings,
} from '../spec/selector-spec.js';
import { applyTransforms } from './transforms.js';

export interface RawVariant {
  value: string | null;
  price: string | null;
  available: string | null;
}

export interface RawItem {
  system: Record<string, string | null>;
  properties: Record<string, string | null>;
  variants: RawVariant[];
}

export interface ExtractionRequest {
  items: Locator;
  system: Record<string, Binding>;
  properties: Record<string, Binding>;
  variants?: VariantBindings;
}

/**
 * Runs inside the page. It is fixed code that only reads the DOM: the spec
 * contributes selectors as data, never anything that is evaluated as code.
 * It must stay self-contained because it is serialized into the page.
 */
export function extractInPage(request: ExtractionRequest): RawItem[] {
  const collapse = (text: string | null | undefined) => {
    const t = (text ?? '').replace(/\s+/g, ' ').trim();
    return t === '' ? null : t;
  };

  const find = (root: Node, locator: Locator): Node[] => {
    if ('css' in locator) {
      return root instanceof Element || root instanceof Document
        ? Array.from(root.querySelectorAll(locator.css))
        : [];
    }
    const snapshot = document.evaluate(
      locator.xpath,
      root,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const found: Node[] = [];
    for (let i = 0; i < snapshot.snapshotLength; i++) {
      const n = snapshot.snapshotItem(i);
      if (n) found.push(n);
    }
    return found;
  };

  const read = (root: Node, binding: Binding, field: string) => {
    const target = binding.locator ? find(root, binding.locator)[0] : root;
    if (!target) return null;
    let value: string | null;
    if (binding.source === 'text') {
      value = collapse(target.textContent);
    } else {
      value =
        target instanceof Element
          ? collapse(target.getAttribute(binding.source.attribute))
          : collapse((target as Attr).value);
    }
    if (value && (field === 'link' || field === 'thumbnail_url')) {
      try {
        value = new URL(value, document.baseURI).href;
      } catch {
        // keep the raw text; the transform step reports it
      }
    }
    return value;
  };

  return find(document, request.items).map((element) => {
    const system: Record<string, string | null> = {};
    for (const [field, binding] of Object.entries(request.system))
      system[field] = read(element, binding, field);
    const properties: Record<string, string | null> = {};
    for (const [name, binding] of Object.entries(request.properties))
      properties[name] = read(element, binding, name);
    const variants = request.variants
      ? find(element, request.variants.locator).map((v) => ({
          value: read(v, request.variants!.value, 'variant'),
          price: read(v, request.variants!.price, 'variant_price'),
          available: read(v, request.variants!.available, 'variant_available'),
        }))
      : [];
    return { system, properties, variants };
  });
}

export function extractionRequest(spec: SelectorSpec): ExtractionRequest {
  return {
    items: spec.items.locator,
    system: spec.system,
    properties: spec.properties,
    variants: spec.variants,
  };
}

/** Applies the spec's transforms to raw text; a failure omits the value and records an issue. */
export function buildItems(
  rawItems: RawItem[],
  spec: SelectorSpec,
): { items: ResultItem[]; skipped: number } {
  const items: ResultItem[] = [];
  let skipped = 0;
  for (const raw of rawItems) {
    // Without a name and link an item has no identity and cannot be stored.
    if (!raw.system.name || !raw.system.link) {
      skipped++;
      continue;
    }
    const item: ResultItem = { raw: {}, value: {}, issues: [] };
    const bind = (
      key: string,
      text: string | null,
      binding: Binding,
      into: {
        raw: Record<string, string | null>;
        value: Record<string, unknown>;
        issues: Issue[];
      },
    ) => {
      into.raw[key] = text;
      if (text === null) return;
      const result = applyTransforms(text, binding.transforms);
      if (result.ok) into.value[key] = result.value;
      else
        into.issues.push({
          property: key,
          code: 'transform_failed',
          raw: text,
          message: result.message,
        });
    };
    for (const field of SYSTEM_FIELDS)
      bind(field, raw.system[field] ?? null, spec.system[field], item);
    for (const [name, binding] of Object.entries(spec.properties))
      bind(name, raw.properties[name] ?? null, binding, item);

    if (spec.variants) {
      item.variants = raw.variants.map((rv) =>
        buildVariant(rv, spec.variants!),
      );
    }
    items.push(item);
  }
  return { items, skipped };
}

function buildVariant(
  raw: RawVariant,
  bindings: VariantBindings,
): ResultVariant {
  const variant: ResultVariant = {
    raw: { value: raw.value, price: raw.price, available: raw.available },
    value: {},
    issues: [],
  };
  const text = (key: 'value' | 'price') => {
    if (raw[key] === null) return;
    const result = applyTransforms(raw[key], bindings[key].transforms);
    if (result.ok) variant.value[key] = String(result.value);
    else
      variant.issues.push({
        property: `variant_${key}`,
        code: 'transform_failed',
        raw: raw[key],
        message: result.message,
      });
  };
  text('value');
  text('price');
  const availableChain = bindings.available.transforms;
  if (!availableChain || availableChain.length === 0) {
    variant.value.available = raw.available !== null && raw.available !== '';
  } else if (raw.available !== null) {
    const result = applyTransforms(raw.available, availableChain);
    if (result.ok && typeof result.value === 'boolean')
      variant.value.available = result.value;
    else
      variant.issues.push({
        property: 'variant_available',
        code: 'transform_failed',
        raw: raw.available,
        message: result.ok ? 'did not produce a boolean' : result.message,
      });
  }
  return variant;
}
