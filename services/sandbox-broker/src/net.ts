// The private-address rule of every egress path (phase-7 decision 5, phase-25 decision 23): the
// broker's proxy and the server's `fetch_url` refuse a host that is or resolves to one of these.
import { lookup } from 'node:dns';
import net from 'node:net';

/**
 * Private, loopback, link-local, shared, documentation, benchmark, multicast and reserved ranges,
 * and the IPv6 ranges that can embed an IPv4 address (IPv4-compatible and -translated, NAT64,
 * Teredo, 6to4 and its relay).
 * `BlockList` checks an IPv4-mapped IPv6 address (`::ffff:10.0.0.1`) against the IPv4 rules.
 */
export const PRIVATE = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
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
] as const)
  PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  // IPv4-compatible (covers `::` and `::1`), IPv4-translated (RFC 2765), local-use NAT64 (RFC 8215).
  ['::', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(a, p, 'ipv6');

/** True for an address on the list; anything that is not an IP address counts as private. */
export const isPrivate = (address: string) => {
  const v = net.isIP(address);
  return v === 0 || PRIVATE.check(address, v === 6 ? 'ipv6' : 'ipv4');
};

/** DNS lookup that refuses private, loopback and link-local answers (`EACCES`). */
export const publicLookup: net.LookupFunction = (host, opts, cb) =>
  lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, '', 4);
    if (addrs.some((a) => isPrivate(a.address)))
      return cb(Object.assign(new Error('private address'), { code: 'EACCES' }), '', 4);
    if (opts.all) return cb(null, addrs);
    const [first] = addrs as [(typeof addrs)[number]];
    cb(null, first.address, first.family);
  });
