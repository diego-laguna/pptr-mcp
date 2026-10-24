import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBlockedAddress } from './address-safety.js';

export type HostResolver = (host: string) => Promise<string[]>;

export const systemResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((r) => r.address);

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * Throws UnsafeUrlError unless the URL is http(s), carries no credentials and
 * every address its host resolves to is public. The worker repeats the check on
 * the address it actually connects to, which closes DNS-rebinding gaps.
 */
export async function assertSafeSiteUrl(
  input: string,
  resolve: HostResolver = systemResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError('the URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new UnsafeUrlError(`the scheme ${url.protocol} is not allowed`);
  if (url.username !== '' || url.password !== '')
    throw new UnsafeUrlError('the URL must not contain credentials');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host) !== 0) addresses = [host];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new UnsafeUrlError(`the host ${host} could not be resolved`);
    }
  }
  if (addresses.length === 0)
    throw new UnsafeUrlError(`the host ${host} has no addresses`);
  const bad = addresses.find(isBlockedAddress);
  if (bad)
    throw new UnsafeUrlError(
      `the host ${host} resolves to a non-public address (${bad})`,
    );
  return url;
}
