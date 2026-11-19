import type { Page } from 'puppeteer-core';
import {
  Binding,
  Locator,
  SelectorSpec,
  SYSTEM_FIELDS,
} from '../../scrape/spec/selector-spec.js';

export const MAX_SCREENSHOT_WIDTH = 1600;
export const MAX_SCREENSHOT_HEIGHT = 3000;
export const MAX_SCREENSHOTS = 3;

export interface OverlayTarget {
  name: string;
  /** Item container locator, or a binding locator relative to the first matching item. */
  item: Locator;
  locator?: Locator;
}

/** The bindings to outline: the item container, then each binding inside the first items. */
export function overlayTargets(spec: SelectorSpec): OverlayTarget[] {
  const targets: OverlayTarget[] = [{ name: 'item', item: spec.items.locator }];
  const add = (name: string, binding: Binding) =>
    targets.push({ name, item: spec.items.locator, locator: binding.locator });
  for (const f of SYSTEM_FIELDS) add(f, spec.system[f]);
  for (const [name, b] of Object.entries(spec.properties)) add(name, b);
  if (spec.variants) {
    targets.push({
      name: 'variants',
      item: spec.items.locator,
      locator: spec.variants.locator,
    });
  }
  return targets;
}

/**
 * Runs in the page, after verification. Outlines each bound element in the
 * first few items and labels it with the property name. Returns the names that
 * matched nothing. Self-contained because it is serialized.
 */
export function injectOverlay(
  targets: OverlayTarget[],
  itemsToMark: number,
): string[] {
  const palette = [
    '#e6194b',
    '#3cb44b',
    '#4363d8',
    '#f58231',
    '#911eb4',
    '#008080',
    '#9a6324',
    '#800000',
  ];
  const find = (root: Node, loc: Locator): Node[] => {
    if ('css' in loc)
      return root instanceof Element || root instanceof Document
        ? Array.from(root.querySelectorAll(loc.css))
        : [];
    const snap = document.evaluate(
      loc.xpath,
      root,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const out: Node[] = [];
    for (let i = 0; i < snap.snapshotLength; i++)
      out.push(snap.snapshotItem(i)!);
    return out;
  };
  const layer = document.createElement('div');
  layer.setAttribute('data-discovery-overlay', 'true');
  layer.style.cssText =
    'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  document.body.appendChild(layer);
  const unmatched: string[] = [];
  targets.forEach((target, index) => {
    const color = palette[index % palette.length];
    const items = find(document, target.item).slice(0, itemsToMark);
    let drawn = 0;
    for (const item of items) {
      const nodes = target.locator
        ? find(item, target.locator).slice(0, 1)
        : [item];
      for (const node of nodes) {
        const el = node instanceof Element ? node : node.parentElement;
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const box = document.createElement('div');
        box.style.cssText = `position:absolute;left:${rect.left + scrollX}px;top:${rect.top + scrollY}px;width:${rect.width}px;height:${rect.height}px;outline:2px solid ${color};outline-offset:1px`;
        const label = document.createElement('span');
        label.textContent = target.name;
        label.style.cssText = `position:absolute;left:0;top:-14px;font:bold 11px sans-serif;background:${color};color:#fff;padding:0 3px;white-space:nowrap`;
        box.appendChild(label);
        layer.appendChild(box);
        drawn++;
      }
    }
    if (drawn === 0) unmatched.push(target.name);
  });
  return unmatched;
}

export interface AnnotatedShot {
  png: Uint8Array;
  notHighlighted: string[];
  url: string;
}

/**
 * Captures the page with the overlay. Call only after verification: the overlay
 * adds elements to the DOM and must never be in place while values are extracted.
 */
export async function captureAnnotated(
  page: Page,
  spec: SelectorSpec,
): Promise<AnnotatedShot> {
  const notHighlighted = await page.evaluate(
    injectOverlay,
    overlayTargets(spec),
    3,
  );
  const { width, height } = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  const png = await page.screenshot({
    type: 'png',
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.min(width, MAX_SCREENSHOT_WIDTH),
      height: Math.min(height, MAX_SCREENSHOT_HEIGHT),
    },
  });
  await page.evaluate(() =>
    document.querySelector('[data-discovery-overlay]')?.remove(),
  );
  return { png: png as Uint8Array, notHighlighted, url: page.url() };
}
