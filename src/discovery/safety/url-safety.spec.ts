import { isBlockedAddress } from './address-safety.js';
import { assertSafeSiteUrl, UnsafeUrlError } from './url-safety.js';

const resolver = (map: Record<string, string[]>) => async (host: string) => {
  if (!map[host]) throw new Error('ENOTFOUND');
  return map[host];
};

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.4.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.170.2',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254',
    'fc00::1',
    'ff02::1',
    '::ffff:10.0.0.5',
    '::ffff:7f00:1',
    '64:ff9b::a00:5',
    '[::1]',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '172.15.0.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('refuses text that is not an address', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
  });
});

describe('assertSafeSiteUrl', () => {
  const dns = resolver({
    'shop.example': ['93.184.216.34'],
    'dual.example': ['93.184.216.34', '10.0.0.5'],
    'internal.example': ['10.0.0.5'],
    'v6.example': ['2606:4700:4700::1111'],
    'v6internal.example': ['fd00::1'],
  });

  it('passes a public site', async () => {
    const url = await assertSafeSiteUrl('https://shop.example/kids', dns);
    expect(url.hostname).toBe('shop.example');
    await expect(
      assertSafeSiteUrl('https://v6.example', dns),
    ).resolves.toBeDefined();
  });

  it.each([
    ['a private literal address', 'http://10.0.0.5/'],
    ['the metadata address', 'http://169.254.169.254/latest/meta-data'],
    ['a hostname resolving to a private address', 'https://internal.example'],
    [
      'a hostname with one private address among public ones',
      'https://dual.example',
    ],
    ['an IPv6 loopback literal', 'http://[::1]/'],
    ['an IPv6 private hostname', 'https://v6internal.example'],
    ['a mapped IPv4 literal', 'http://[::ffff:10.0.0.5]/'],
    ['file scheme', 'file:///etc/passwd'],
    ['ftp scheme', 'ftp://shop.example/'],
    ['embedded credentials', 'https://user:pass@shop.example/'],
    ['an unresolvable host', 'https://missing.example'],
    ['garbage', 'not a url'],
  ])('rejects %s', async (_name, url) => {
    await expect(assertSafeSiteUrl(url, dns)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('treats decimal and hex IPv4 forms by their real address', async () => {
    await expect(
      assertSafeSiteUrl('http://2130706433/', dns),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(
      assertSafeSiteUrl('http://0x7f.1/', dns),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
