export const SPEC_FORMAT_VERSION = 1;

export type Locator = { css: string } | { xpath: string };

export type Source = 'text' | { attribute: string };

export type Transform =
  | { type: 'trim' }
  | { type: 'regex'; pattern: string; group?: number }
  | { type: 'number'; locale: string }
  | { type: 'date'; format: string; locale?: string }
  | { type: 'enum_map'; map: Record<string, string> }
  | { type: 'boolean_map'; true: string[]; false: string[] }
  | { type: 'split'; separator: string };

export interface Binding {
  /** Relative to the item (or variant) element; absent means the element itself. */
  locator?: Locator;
  source: Source;
  transforms?: Transform[];
}

export type Step =
  | { type: 'open_url'; url: string }
  | { type: 'click'; locator: Locator }
  | { type: 'wait_for'; locator: Locator; timeoutMs?: number }
  | { type: 'scroll'; times?: number };

export type Pagination =
  | { mode: 'next_button'; locator: Locator; maxPages: number }
  | {
      mode: 'url_template';
      /** Contains `{page}`. */
      template: string;
      startPage: number;
      maxPages: number;
    }
  | { mode: 'infinite_scroll'; maxScrolls: number; maxPages: number };

export const SYSTEM_FIELDS = [
  'name',
  'link',
  'price',
  'thumbnail_url',
] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];

export interface VariantBindings {
  locator: Locator;
  value: Binding;
  price: Binding;
  available: Binding;
}

export interface SelectorSpec {
  formatVersion: number;
  site: { url: string };
  steps: Step[];
  pagination?: Pagination;
  items: { locator: Locator };
  system: Record<SystemField, Binding>;
  /** Schema property name -> binding. */
  properties: Record<string, Binding>;
  variants?: VariantBindings;
}
