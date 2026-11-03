import { isIPv6 } from 'node:net';

const IPV6_GROUP_COUNT = 8;
const IPV6_SUBNET_GROUPS = 4;
const IPV6_ALLOCATION_GROUPS = 3;
const BITS_PER_IPV6_GROUP = 16;
const IPV4_MAPPED_ADDRESS = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

export function toClientNetwork(address: string): string {
  return toNetwork(address, IPV6_SUBNET_GROUPS);
}

export function toClientAllocation(address: string): string {
  return toNetwork(address, IPV6_ALLOCATION_GROUPS);
}

function toNetwork(address: string, ipv6Groups: number): string {
  const [unzonedAddress = address] = address.split('%');
  const ipv4 = IPV4_MAPPED_ADDRESS.exec(unzonedAddress)?.[1];
  if (ipv4) {
    return ipv4;
  }
  if (!isIPv6(unzonedAddress)) {
    return unzonedAddress;
  }

  const [head = '', tail = ''] = unzonedAddress.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const omittedGroups = Array.from<string>({
    length: IPV6_GROUP_COUNT - headGroups.length - tailGroups.length,
  }).fill('0');

  const networkGroups = [...headGroups, ...omittedGroups, ...tailGroups]
    .slice(0, ipv6Groups)
    .map((group) => group.toLowerCase().padStart(4, '0'));
  return `${networkGroups.join(':')}::/${ipv6Groups * BITS_PER_IPV6_GROUP}`;
}
