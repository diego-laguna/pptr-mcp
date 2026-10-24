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

export function resultKey(
  customerId: string,
  catalogId: string,
  siteId: string,
  runId: string,
): string {
  // A single leading `runs/` prefix lets one lifecycle rule expire raw results without touching specs.
  return `runs/${customerId}/${catalogId}/${siteId}/${runId}/result.json`;
}
