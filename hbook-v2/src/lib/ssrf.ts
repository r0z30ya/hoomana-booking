/**
 * hbook — SSRF protection for webhook destinations.
 *
 * Blocks: localhost / loopback, private networks (RFC1918, CGNAT),
 * link-local (incl. cloud metadata 169.254.169.254), ULA, multicast,
 * documentation ranges, IPv4-mapped IPv6 and all-non-public DNS answers
 * (defends against DNS rebinding: EVERY resolved address must be public).
 *
 * HTTPS is mandatory in production; plain http needs the explicit dev flag
 * HBOOK_WEBHOOK_ALLOW_INSECURE_HTTP=1 (never honored in production).
 */

import { lookup } from 'node:dns';
import { config } from '../config';
import { unprocessable } from './errors';

export interface ResolvedTarget {
  protocol: 'https:' | 'http:';
  hostname: string;
  port: string;
  path: string;
  /** First validated IP — used for logging only (never for connecting directly). */
  address: string;
}

class BlockedDestinationError extends Error {}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const [a, b, c, d] = m.slice(1).map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function inCidr(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata!)
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved / broadcast
];

const V6_BLOCKED_PREFIXES = [
  '::', // unspecified
  '::1', // loopback
  'fc', // fc00::/7 unique local
  'fd', // fc00::/7 unique local
  'fe8', // fe80::/10 link-local
  'fe9',
  'fea',
  'feb',
  'ff', // ff00::/8 multicast
  '2001:db8', // documentation
];

function isForbiddenAddress(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) {
    const n = ipv4ToInt(mapped[1]);
    if (n !== null && V4_BLOCKED.some(([b, bits]) => inCidr(n, b, bits))) return true;
  }
  const lower = ip.toLowerCase();
  for (const p of V6_BLOCKED_PREFIXES) {
    if (lower.startsWith(p)) return true;
  }
  const n = ipv4ToInt(ip);
  if (n !== null) {
    for (const [b, bits] of V4_BLOCKED) {
      if (inCidr(n, b, bits)) return true;
    }
  }
  return false;
}

function isPlainHostname(hostname: string): boolean {
  return !/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && !hostname.includes(':');
}

function resolveAll(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return reject(err);
      resolve(addresses.map((a) => a.address));
    });
  });
}

/**
 * Validate a webhook URL and resolve it NOW. Returns connection details.
 * Every DNS answer must be public — one private answer rejects the target.
 */
export async function assertWebhookUrl(
  rawUrl: string,
  opts: { forCreation?: boolean } = {},
): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw unprocessable('INVALID_URL', 'Webhook URL is not a valid URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw unprocessable('INVALID_URL', 'Webhook URL must use http or https.');
  }
  if (url.username || url.password) {
    throw unprocessable('INVALID_URL', 'Webhook URL must not embed credentials.');
  }
  if (url.protocol === 'http:') {
    const allowed = !config.isProd && config.webhook.allowInsecureHttp;
    if (!allowed) {
      throw unprocessable(
        'INSECURE_WEBHOOK_URL',
        opts.forCreation
          ? 'Webhook URLs must use https:// (plain http is only allowed in non-production with HBOOK_WEBHOOK_ALLOW_INSECURE_HTTP=1).'
          : 'Plain http webhooks are disabled — re-create the webhook with https://.',
      );
    }
  }

  // test escape hatch: private destinations only outside production AND with
  // an explicit flag (docs/INTEGRATION.md — never honored in production)
  const allowPrivate = !config.isProd && config.webhook.allowPrivateIps;
  if (!allowPrivate) {
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      throw unprocessable('FORBIDDEN_WEBHOOK_TARGET', 'Webhook target is not a public host.');
    }

    const addresses = await resolveAll(hostname).catch(() => {
      throw unprocessable('INVALID_URL', `Webhook host "${url.hostname}" does not resolve.`);
    });
    if (addresses.length === 0) {
      throw unprocessable('INVALID_URL', `Webhook host "${url.hostname}" does not resolve.`);
    }
    for (const ip of addresses) {
      if (isForbiddenAddress(ip)) {
        throw unprocessable(
          'FORBIDDEN_WEBHOOK_TARGET',
          'Webhook target resolves to a private, loopback or link-local address.',
        );
      }
    }
    return {
      protocol: url.protocol as 'https:' | 'http:',
      hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      path: `${url.pathname}${url.search}` || '/',
      address: addresses[0],
    };
  }

  return {
    protocol: url.protocol as 'https:' | 'http:',
    hostname: url.hostname.toLowerCase().replace(/\.$/, ''),
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    path: `${url.pathname}${url.search}` || '/',
    address: url.hostname,
  };
}

export { isForbiddenAddress, BlockedDestinationError };
