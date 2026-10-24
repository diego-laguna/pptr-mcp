/**
 * Candidate and evidence for one attempt, under the owning customer. The single
 * leading `discoveries/` prefix lets one lifecycle rule expire evidence.
 */
export function discoveryOutputPrefix(
  customerId: string,
  siteId: string,
  attemptId: string,
): string {
  return `discoveries/${customerId}/${siteId}/${attemptId}`;
}
