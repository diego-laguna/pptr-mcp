/** All objects live under the owning customer's prefix. */
export function sitePrefix(customerId: string, siteId: string): string {
  return `customers/${customerId}/sites/${siteId}`;
}

export function specKey(
  customerId: string,
  siteId: string,
  version: number,
): string {
  return `${sitePrefix(customerId, siteId)}/specs/${version}.json`;
}

/** Interim pointer to the active spec version, until activation owns it. */
export function activePointerKey(customerId: string, siteId: string): string {
  return `${sitePrefix(customerId, siteId)}/specs/active.json`;
}

export function resultKey(
  customerId: string,
  catalogId: string,
  siteId: string,
  runId: string,
): string {
  return `customers/${customerId}/catalogs/${catalogId}/sites/${siteId}/runs/${runId}/result.json`;
}
