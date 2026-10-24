import { CatalogSchema } from './schema/property-types.js';
import { SchemaOperation } from './schema/operations.js';

export interface Customer {
  id: string;
  name: string;
  createdAt: Date;
}

export interface Catalog {
  id: string;
  customerId: string;
  name: string;
  schemaVersion: number;
  createdAt: Date;
}

export interface SchemaVersion {
  catalogId: string;
  version: number;
  schema: CatalogSchema;
  variantProperty: string | null;
  changes: SchemaOperation[];
  createdAt: Date;
}

export interface CatalogWithSchema extends Catalog {
  schema: CatalogSchema;
  variantProperty: string | null;
}

export interface Site {
  id: string;
  catalogId: string;
  url: string;
  name: string;
  country: string;
  currency: string;
  createdAt: Date;
}

export interface NewSite {
  url: string;
  name: string;
  country: string;
  currency: string;
}

export interface AttentionMarker {
  id: string;
  siteId: string;
  reason: string;
  property: string | null;
  createdAt: Date;
  clearedAt: Date | null;
}

export interface ProductVariant {
  id: string;
  productId: string;
  variantValue: string;
  price: string;
  available: boolean;
  updatedAt: Date;
}

export interface Product {
  id: string;
  siteId: string;
  name: string;
  link: string;
  thumbnailUrl: string | null;
  attributes: Record<string, unknown>;
  /** Price text exactly as shown; set only when the catalog has no variant property. */
  price: string | null;
  available: boolean | null;
  updatedAt: Date;
  variants: ProductVariant[];
}

export interface NewVariant {
  value: string;
  price: string;
  available: boolean;
}

export interface ProductInput {
  name: string;
  link: string;
  thumbnailUrl?: string | null;
  attributes?: Record<string, unknown>;
  price?: string | null;
  available?: boolean | null;
  variants?: NewVariant[];
}

export interface ProductSearch {
  catalogId?: string;
  siteId?: string;
  /** Containment: every key/value must be present in the product's attributes. */
  attributes?: Record<string, unknown>;
  /** Free text on the product name. */
  text?: string;
  limit?: number;
  offset?: number;
}

export interface VariantMatch {
  variant: ProductVariant;
  product: Omit<Product, 'variants'>;
}
