import { activePointerKey } from '../storage/keys.js';
import { ObjectStore } from '../storage/object-store.js';

/** Which spec version is live for a site. */
export interface ActiveSpecResolver {
  resolve(customerId: string, siteId: string): Promise<number | null>;
}

/** Interim: reads `active.json` next to the spec versions, until activation owns the pointer. */
export class PointerActiveSpecResolver implements ActiveSpecResolver {
  constructor(private readonly objects: ObjectStore) {}

  async resolve(customerId: string, siteId: string): Promise<number | null> {
    const body = await this.objects.get(activePointerKey(customerId, siteId));
    if (body === null) return null;
    try {
      const version = (JSON.parse(body) as { version?: unknown }).version;
      return typeof version === 'number' &&
        Number.isInteger(version) &&
        version >= 1
        ? version
        : null;
    } catch {
      return null;
    }
  }
}
