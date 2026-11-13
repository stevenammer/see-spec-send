import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

// Shapes that carry a credential: `key: value`, `key=value`, JSON `"key": "value"`, and bare
// `Bearer x` or `Basic x`. The key or scheme stays so an operator can see what was hidden.
const KEYED = /(["']?)\b(authorization|api[-_ ]?key|token|secret|password)\1(\s*[:=]\s*)(["']?)((?:(?:Bearer|Basic)\s+)?[^\s,"'}&]+)\4/gi;
const CREDENTIAL = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
export const redact = value => String(value)
  .replace(KEYED, (_match, _quote, key) => `${key}=[redacted]`)
  .replace(CREDENTIAL, '$1 [redacted]');

// Every range a provider or webhook must never reach. IPv4 is matched on 32-bit integers and IPv6 on 128-bit BigInts.
const RESERVED_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];
// 2001::/23 already holds Teredo, ORCHID and the benchmark block; 2001:db8::/32 is documentation.
const RESERVED_V6 = ['::/96', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8'];
const v4Int = ip => ip.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
const v6Big = ip => {
  let text = ip;
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) { const n = v4Int(dotted[1]); text = `${text.slice(0, -dotted[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const halves = text.split('::');
  if (halves.length > 2) throw Error('bad IPv6 address');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  if (groups.length !== 8) throw Error('bad IPv6 address');
  return groups.reduce((total, group) => (total << 16n) + BigInt(parseInt(group, 16)), 0n);
};
const v4Range = cidr => { const [base, bits] = cidr.split('/'); const size = 2 ** (32 - Number(bits)); return [Math.floor(v4Int(base) / size), size]; };
const v6Range = cidr => { const [base, bits] = cidr.split('/'); const shift = BigInt(128 - Number(bits)); return [v6Big(base) >> shift, shift]; };
const V4 = RESERVED_V4.map(v4Range);
const V6 = RESERVED_V6.map(v6Range);
const reservedV4 = value => V4.some(([index, size]) => Math.floor(value / size) === index);

// Returns true for anything that is not a plain address, so an unparseable answer is refused.
export function addressIsReserved(ip) {
  if (isIP(ip) === 4) return reservedV4(v4Int(ip));
  if (isIP(ip) !== 6) return true;
  const value = v6Big(ip);
  const top96 = value >> 32n;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) addresses carry an IPv4 answer in their low 32 bits.
  if (top96 === 0xffffn || top96 === (0x0064ff9bn << 64n)) return reservedV4(Number(value & 0xffffffffn));
  // The translated form (::ffff:0:0:0/96) is never a legitimate destination.
  if (top96 === (0xffffn << 32n)) return true;
  return V6.some(([index, shift]) => (value >> shift) === index);
}
export const privateAddress = addressIsReserved;

// Hostnames in URLs keep their brackets for IPv6 literals; the address itself does not have them.
const literal = hostname => hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
const defaultResolver = hostname => lookup(hostname, { all: true, verbatim: true });

// Checks the URL and every answer for the host once, and returns the address the connection must use.
export async function resolvePinned(raw, { hosts, allowPrivate = false, resolver = defaultResolver } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw Error('invalid provider URL'); }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw Error('HTTPS required');
  if (url.username || url.password || url.hash) throw Error('credentials in provider URLs are refused');
  // Azure's documented chat-completions endpoint needs this non-secret query.
  if ([...url.searchParams.keys()].some(key => key !== 'api-version') || url.searchParams.getAll('api-version').length > 1) throw Error('provider URL query refused');
  if (!Array.isArray(hosts) || !hosts.includes(url.hostname)) throw Error('provider host is not allowlisted');
  const name = literal(url.hostname);
  const answers = isIP(name) ? [{ address: name }] : await resolver(url.hostname);
  if (!answers.length || (!allowPrivate && answers.some(({ address }) => addressIsReserved(address)))) throw Error('private provider address refused');
  const [{ address }] = answers;
  return { url, address, family: isIP(address) };
}

export async function checkedUrl(raw, options) {
  return (await resolvePinned(raw, options)).url;
}

// The only dialer. It connects to `address` and keeps the URL's hostname for the Host header and TLS.
// Redirects are never followed.
export function pinnedFetch(url, { address, method = 'GET', headers = {}, body, signal } = {}) {
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const family = isIP(address);
  return new Promise((resolve, reject) => {
    // An absent credential sends no header at all, rather than the string "undefined".
    const sent = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const req = transport(url, { method, headers: sent, signal,
      lookup: (_host, options, done) => (options?.all ? done(null, [{ address, family }]) : done(null, address, family)) }, res => {
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: Readable.toWeb(res) });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function jsonRequest(raw, { hosts, allowPrivate, headers = {}, body, timeoutMs = 10_000, requestBytes = 128 * 1024, responseBytes = 128 * 1024, signal, resolver, connector = pinnedFetch } = {}) {
  const pin = await resolvePinned(raw, { hosts, allowPrivate, resolver });
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > requestBytes) throw Error('provider request byte limit');
  const abort = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
  let response;
  try {
    response = await connector(pin.url, { address: pin.address, family: pin.family, method: 'POST', signal: abort,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...headers }, body: encoded });
  } catch (error) { throw Error(`provider request failed: ${redact(error.message)}`); }
  if (!response.ok) throw Error(`provider HTTP ${response.status}`);
  const reader = response.body?.getReader(); let bytes = 0; const chunks = [];
  if (!reader) throw Error('provider response missing body');
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length;
      if (bytes > responseBytes) { await reader.cancel(); throw Error('provider response byte limit'); } chunks.push(value); }
  } catch (error) { throw Error(`provider response failed: ${redact(error.message)}`); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('provider returned malformed JSON'); }
}
