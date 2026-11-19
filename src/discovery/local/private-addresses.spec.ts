import { isBlockedAllowingPrivate } from './private-addresses.js';

describe('isBlockedAllowingPrivate', () => {
  it.each(['127.0.0.1', '::1', '10.1.2.3', '172.16.0.9', '192.168.1.5'])(
    'lets %s through',
    (a) => expect(isBlockedAllowingPrivate(a)).toBe(false),
  );
  it.each([
    '169.254.169.254',
    'fd00:ec2::254',
    'fe80::1',
    '100.64.0.1',
    '0.0.0.0',
    'not-an-ip',
  ])('keeps %s blocked', (a) => expect(isBlockedAllowingPrivate(a)).toBe(true));
  it('lets public addresses through', () =>
    expect(isBlockedAllowingPrivate('93.184.216.34')).toBe(false));
});
