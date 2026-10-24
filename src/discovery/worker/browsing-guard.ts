import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { HTTPRequest, HTTPResponse, Page } from 'puppeteer-core';
import { isBlockedAddress } from '../safety/address-safety.js';
import type { GuardEvent } from '../verify/evidence.js';

export interface GuardOptions {
  /** The target site's URL; top-level navigation is confined to its domain and subdomains. */
  siteUrl: string;
  onEvent?: (event: GuardEvent) => void;
  /** Replaceable in tests so local servers can stand in for public and internal hosts. */
  isBlocked?: (address: string) => boolean;
  resolveHost?: (host: string) => Promise<string[]>;
}

export interface BrowsingGuard {
  events: GuardEvent[];
}

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true })).map((r) => r.address);

/** The site's host without a leading `www.`; subdomains of it are in scope. */
export function siteScope(siteUrl: string): string {
  return new URL(siteUrl).hostname.replace(/^www\./, '').toLowerCase();
}

export function inScope(host: string, scope: string): boolean {
  const h = host.toLowerCase();
  return h === scope || h.endsWith(`.${scope}`);
}

/**
 * Request interception on every request, including each redirect hop:
 * only http(s); top-level navigation confined to the site's domain; every
 * request's host must resolve to public addresses only; the connected address
 * is checked again on the response, which closes DNS-rebinding gaps; downloads
 * are denied.
 */
export async function installBrowsingGuard(
  page: Page,
  options: GuardOptions,
): Promise<BrowsingGuard> {
  const events: GuardEvent[] = [];
  const isBlocked = options.isBlocked ?? isBlockedAddress;
  const resolve = options.resolveHost ?? defaultResolve;
  const scope = siteScope(options.siteUrl);
  const record = (event: GuardEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };
  const verdicts = new Map<string, Promise<string | null>>();

  /** Returns the blocked address when the host resolves to one, else null. */
  const blockedAddressOf = (host: string): Promise<string | null> => {
    const bare = host.replace(/^\[|\]$/g, '');
    let verdict = verdicts.get(bare);
    if (!verdict) {
      verdict = (async () => {
        try {
          const addresses = isIP(bare) !== 0 ? [bare] : await resolve(bare);
          if (addresses.length === 0) return '(no address)';
          return addresses.find(isBlocked) ?? null;
        } catch {
          return '(unresolvable)';
        }
      })();
      verdicts.set(bare, verdict);
    }
    return verdict;
  };

  await page.setRequestInterception(true);
  page.on('request', (request: HTTPRequest) => {
    void (async () => {
      if (request.isInterceptResolutionHandled()) return;
      const url = request.url();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        record({ kind: 'blocked_scheme', url });
        return request.abort('blockedbyclient');
      }
      if (parsed.protocol === 'about:' && url === 'about:blank')
        return request.continue();
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        record({ kind: 'blocked_scheme', url });
        return request.abort('blockedbyclient');
      }
      const bad = await blockedAddressOf(parsed.hostname);
      if (bad !== null) {
        record({ kind: 'blocked_address', url, detail: bad });
        return request.abort('blockedbyclient');
      }
      const navigating =
        request.isNavigationRequest() && request.frame() === page.mainFrame();
      if (navigating && !inScope(parsed.hostname, scope)) {
        record({ kind: 'blocked_domain', url, detail: `outside ${scope}` });
        return request.abort('blockedbyclient');
      }
      return request.continue();
    })().catch(() => undefined);
  });

  page.on('response', (response: HTTPResponse) => {
    const ip = response.remoteAddress().ip;
    if (ip && isBlocked(ip)) {
      record({
        kind: 'blocked_address',
        url: response.url(),
        detail: `connected to ${ip}`,
      });
      void page.goto('about:blank').catch(() => undefined);
    }
  });

  const cdp = await page.createCDPSession();
  await cdp
    .send('Browser.setDownloadBehavior', { behavior: 'deny' })
    .catch(() => undefined);
  await cdp
    .send('Page.setDownloadBehavior', { behavior: 'deny' })
    .catch(() => undefined);

  return { events };
}
