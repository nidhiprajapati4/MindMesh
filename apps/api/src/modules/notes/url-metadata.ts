import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { decodeEntities } from '../../lib/html';

const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

export type UrlMetadata = {
  finalUrl: string;
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
};

// Addresses the server must never be tricked into calling (SSRF): loopback, private,
// link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast and reserved ranges.
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(addr, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (!family) return false;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) must be judged as the IPv4 address it wraps.
  const mapped = family === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * DNS lookup used by the socket itself, so the address we validate is the one we connect to
 * (no DNS-rebinding gap between "check" and "connect").
 */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || !list.every((a) => isPublicAddress(a.address))) {
      return callback(Object.assign(new Error('Address not allowed'), { code: 'EBLOCKED' }), '', 0);
    }
    if ((options as dns.LookupOptions).all) (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

export function assertFetchableUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Only standard ports are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // IP literals skip DNS lookup entirely, so check them here.
  if (net.isIP(host) && !isPublicAddress(host)) throw new Error('Address not allowed');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Address not allowed');
  return url;
}

type RawResponse = { status: number; location?: string; contentType: string; body: string };

function request(url: URL): Promise<RawResponse> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'MindMeshBot/0.2 (+link preview)', Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '');
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, contentType, body: '' });
        }
        if (!/text\/html|application\/xhtml/i.test(contentType)) {
          res.destroy();
          return resolve({ status, contentType, body: '' });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
          // <head> is near the top; stop reading once we have enough.
          if (size >= MAX_BYTES) res.destroy();
        });
        res.on('close', () => resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

const clean = (s: string | undefined, max: number) => {
  const v = s && decodeEntities(s).replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, max) : undefined;
};

export function parseHtmlMetadata(html: string) {
  const head = html.slice(0, MAX_BYTES);
  const metas = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    const key = attr('property') ?? attr('name');
    const content = attr('content');
    if (key && content) {
      const k = (key[1] ?? key[2] ?? key[3]).toLowerCase();
      if (!metas.has(k)) metas.set(k, content[1] ?? content[2] ?? content[3]);
    }
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  return {
    title: clean(metas.get('og:title') ?? metas.get('twitter:title') ?? titleTag, 200),
    description: clean(metas.get('og:description') ?? metas.get('description') ?? metas.get('twitter:description'), 1000),
    siteName: clean(metas.get('og:site_name'), 200),
    author: clean(metas.get('author') ?? metas.get('article:author'), 200),
  };
}

/** Fetches an HTML page through the SSRF guard, following up to MAX_REDIRECTS validated redirects. */
export async function fetchHtml(raw: string): Promise<{ finalUrl: string; html: string }> {
  let url = assertFetchableUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await request(url);
    if (res.location && res.status >= 300 && res.status < 400) {
      url = assertFetchableUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`Upstream responded ${res.status}`);
    return { finalUrl: url.toString(), html: res.body };
  }
  throw new Error('Too many redirects');
}

export async function fetchUrlMetadata(raw: string): Promise<UrlMetadata> {
  const { finalUrl, html } = await fetchHtml(raw);
  return { finalUrl, ...parseHtmlMetadata(html) };
}
