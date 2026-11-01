import { describe, expect, it } from 'vitest';
import { toClientNetwork } from './client-network.js';

describe('toClientNetwork', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(toClientNetwork('203.0.113.9')).toBe('203.0.113.9');
  });

  it('treats an IPv4-mapped address as the IPv4 address', () => {
    expect(toClientNetwork('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('groups addresses of the same IPv6 /64 together', () => {
    const first = toClientNetwork('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const second = toClientNetwork('2001:db8:1:2::1');

    expect(first).toBe('2001:0db8:0001:0002::/64');
    expect(second).toBe(first);
  });

  it('separates different IPv6 networks', () => {
    expect(toClientNetwork('2001:db8:1:3::1')).not.toBe(toClientNetwork('2001:db8:1:2::1'));
  });

  it('expands the omitted groups, whatever the letter case or zone', () => {
    expect(toClientNetwork('2001:DB8::1%eth0')).toBe('2001:0db8:0000:0000::/64');
    expect(toClientNetwork('::1')).toBe('0000:0000:0000:0000::/64');
  });
});
