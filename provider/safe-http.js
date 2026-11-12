import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const SECRET = /(authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,}]+/gi;
export const redact = value => String(value).replace(SECRET, '$1=[redacted]');
const privateV4 = ip => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const privateV6 = ip => ip === '::1' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip) || ip === '::ffff:127.0.0.1';
export const privateAddress = ip => privateV4(ip) || privateV6(ip);

export async function checkedUrl(raw, { hosts, allowPrivate = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw Error('invalid provider URL'); }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw Error('HTTPS required');
  if (url.username || url.password || url.hash) throw Error('credentials in provider URLs are refused');
  // Azure's documented chat-completions endpoint needs this non-secret query.
  if ([...url.searchParams.keys()].some(key => key !== 'api-version') || url.searchParams.getAll('api-version').length > 1) throw Error('provider URL query refused');
  if (!Array.isArray(hosts) || !hosts.includes(url.hostname)) throw Error('provider host is not allowlisted');
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || (!allowPrivate && addresses.some(({ address }) => privateAddress(address)))) throw Error('private provider address refused');
  return url;
}

export async function jsonRequest(raw, { hosts, allowPrivate, headers = {}, body, timeoutMs = 10_000, requestBytes = 128 * 1024, responseBytes = 128 * 1024, signal } = {}) {
  const url = await checkedUrl(raw, { hosts, allowPrivate });
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > requestBytes) throw Error('provider request byte limit');
  const abort = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
  let response;
  try {
    response = await fetch(url, { method: 'POST', redirect: 'error', signal: abort,
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
