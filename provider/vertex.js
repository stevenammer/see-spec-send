// Google Vertex AI through its OpenAI-compatible chat endpoint, signed in with a service account.
// No Google library: the sign-in is a signed JWT exchanged for a short-lived token, using only node:crypto.
// The key file is read once, must be readable by its owner only, and is never logged or put in an error.
import { createSign } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { pinnedFetch, redact, resolvePinned } from './safe-http.js';

const b64 = value => Buffer.from(value).toString('base64url');

export function readServiceAccount(keyFile) {
  if (typeof keyFile !== 'string' || !keyFile.startsWith('/')) throw Error('service account file must be an absolute path');
  // Open once, then check and read the same open file, so the file cannot be swapped between the check and the read.
  const fd = openSync(keyFile, 'r');
  let text;
  try {
    const stat = fstatSync(fd);
    if (stat.mode & 0o077) throw Error('service account file is readable by others; refusing to use it');
    if (stat.uid !== process.getuid()) throw Error('service account file is not owned by the service user; refusing to use it');
    try { text = readFileSync(fd, 'utf8'); } catch { throw Error('invalid service account file'); }
  } finally { closeSync(fd); }
  let parsed; try { parsed = JSON.parse(text); } catch { throw Error('invalid service account file'); }
  if (parsed?.type !== 'service_account' || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') throw Error('invalid service account file');
  return { email: parsed.client_email, key: parsed.private_key, tokenUri: typeof parsed.token_uri === 'string' ? parsed.token_uri : 'https://oauth2.googleapis.com/token' };
}

// Returns an async function that gives a current access token, asking Google only when the last one is nearly out.
export function serviceAccountTokens({ keyFile, clock = Date.now, tokenUri = null, allowPrivate = false, resolver, connector = pinnedFetch } = {}) {
  const account = readServiceAccount(keyFile);
  const endpoint = tokenUri || account.tokenUri;
  let cached = null; let pending = null;
  const mint = async () => {
    const now = Math.floor(clock() / 1000);
    const claim = { iss: account.email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: endpoint, iat: now, exp: now + 3600 };
    const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify(claim))}`;
    const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(account.key).toString('base64url')}`;
    const pin = await resolvePinned(endpoint, { hosts: [new URL(endpoint).hostname], allowPrivate, resolver });
    let response;
    try {
      response = await connector(pin.url, { address: pin.address, family: pin.family, method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
    } catch (error) { throw Error(`sign-in request failed: ${redact(error.message)}`); }
    if (!response.ok) throw Error(`sign-in refused (HTTP ${response.status})`);
    const chunks = []; let bytes = 0; const reader = response.body.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 16 * 1024) throw Error('sign-in response too large'); chunks.push(value); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('sign-in returned malformed JSON'); }
    if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in)) throw Error('sign-in returned no token');
    cached = { token: data.access_token, until: clock() + Math.max(60, data.expires_in - 120) * 1000 };
    return cached.token;
  };
  return async () => {
    if (cached && clock() < cached.until) return cached.token;
    pending ??= mint().finally(() => { pending = null; });
    return pending;
  };
}

export const vertexUrl = ({ project, location }) => `https://${location === 'global' ? '' : `${location}-`}aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/endpoints/openapi/chat/completions`;
export const vertexHost = ({ location }) => `${location === 'global' ? '' : `${location}-`}aiplatform.googleapis.com`;
