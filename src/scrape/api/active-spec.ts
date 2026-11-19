/** Which spec version is live for a site; the database implementation is in the activation module. */
export interface ActiveSpecResolver {
  resolve(customerId: string, siteId: string): Promise<number | null>;
}
