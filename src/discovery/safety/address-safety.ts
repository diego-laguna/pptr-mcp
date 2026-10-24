import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
const v4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including 169.254.169.254 and the ECS metadata address
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [net, prefix] of v4) blocked.addSubnet(net, prefix, 'ipv4');
const v6: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local, including the AWS IPv6 metadata address
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['100::', 64],
];
for (const [net, prefix] of v6) blocked.addSubnet(net, prefix, 'ipv6');

/** True for loopback, private, link-local, multicast and other non-public addresses. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0];
  const family = isIP(bare);
  if (family === 0) return true; // not an address: refuse rather than guess
  const lower = bare.toLowerCase();
  // IPv4-mapped and NAT64 forms carry an IPv4 address that decides the outcome.
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedAddress(mapped[1]);
  const mappedHex =
    /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return blocked.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}
