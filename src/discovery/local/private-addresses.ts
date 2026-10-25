import { BlockList, isIP } from 'node:net';
import { isBlockedAddress } from '../safety/address-safety.js';

const allowed = new BlockList();
for (const [net, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  allowed.addSubnet(net, prefix, 'ipv4');
allowed.addAddress('::1', 'ipv6');

/**
 * The production predicate with loopback and RFC 1918 addresses let through, for
 * local fixtures and own sites. Link-local (including the cloud metadata
 * address), carrier-grade NAT, unique-local IPv6 and everything else stay blocked.
 */
export function isBlockedAllowingPrivate(address: string): boolean {
  if (!isBlockedAddress(address)) return false;
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0];
  const family = isIP(bare);
  if (family === 0) return true;
  return !allowed.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}
