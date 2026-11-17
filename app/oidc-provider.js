import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { pinnedFetch, resolvePinned } from '../provider/safe-http.js';

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_JWKS_KEYS = 64;
const UNKNOWN_KID_REFRESH_MS = 60_000;
const DISCOVERY_REFRESH_MS = 6 * 60 * 60_000;
const cleanUrl = (value, name, { allowInsecureLoopback = false, hosts = [] } = {}) => {
  let url;
  try { url = new URL(value); } catch { throw new Error(`OIDC ${name} is invalid`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:'))
    || url.username || url.password || url.hash || url.search || !hosts.includes(url.hostname)) {
    throw new Error(`OIDC ${name} is refused`);
  }
  return url.toString().replace(/\/$/, '');
};
const b64json = value => {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new Error('OIDC token refused'); }
};
const equal = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const derInteger = raw => {
  let value = Buffer.from(raw);
  while (value.length > 1 && value[0] === 0) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return Buffer.concat([Buffer.from([2, value.length]), value]);
};
const joseEcdsaToDer = signature => {
  if (![64, 96, 132].includes(signature.length) || signature.length % 2) throw new Error('OIDC token refused');
  const body = Buffer.concat([derInteger(signature.subarray(0, signature.length / 2)), derInteger(signature.subarray(signature.length / 2))]);
  if (body.length >= 128) throw new Error('OIDC token refused');
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};
const readBody = async (response, limit = MAX_RESPONSE_BYTES) => {
  const reader = response?.body?.getReader();
  if (!reader) throw new Error('OIDC response refused');
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) { await reader.cancel(); throw new Error('OIDC response refused'); }
      chunks.push(value);
    }
  } catch { throw new Error('OIDC response refused'); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('OIDC response refused'); }
};

export function validateOidcConfig(input, { secure = true, env = process.env } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('OIDC configuration is invalid');
  const allowed = new Set(['issuer', 'clientId', 'clientSecretEnv', 'redirectUri', 'hosts', 'scopes', 'tenantId', 'allowedEmailDomains', 'autoProvision', 'clockSkewSeconds', 'clientAuth', 'allowInsecureLoopbackForDevelopment']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('OIDC configuration has an unknown field');
  const development = input.allowInsecureLoopbackForDevelopment === true;
  if (development && secure) throw new Error('OIDC insecure loopback mode is refused in --secure mode');
  if (!Array.isArray(input.hosts) || !input.hosts.length || input.hosts.length > 16 || input.hosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host))) throw new Error('OIDC hosts are invalid');
  const options = { allowInsecureLoopback: development, hosts: input.hosts };
  const issuer = cleanUrl(input.issuer, 'issuer', options);
  const redirectUri = cleanUrl(input.redirectUri, 'redirect URI', options);
  if (typeof input.clientId !== 'string' || !input.clientId || input.clientId.length > 512) throw new Error('OIDC client ID is invalid');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(input.clientSecretEnv || '')) throw new Error('OIDC secret environment variable is invalid');
  if (typeof env[input.clientSecretEnv] !== 'string' || !env[input.clientSecretEnv]) throw new Error('OIDC client secret is unavailable');
  const scopes = input.scopes === undefined ? ['openid', 'email'] : input.scopes;
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 16 || scopes.some(scope => typeof scope !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(scope)) || !scopes.includes('openid')) throw new Error('OIDC scopes are invalid');
  if (input.tenantId !== undefined && (typeof input.tenantId !== 'string' || !input.tenantId || input.tenantId.length > 200)) throw new Error('OIDC tenant ID is invalid');
  if (input.allowedEmailDomains !== undefined && (!Array.isArray(input.allowedEmailDomains) || !input.allowedEmailDomains.length || input.allowedEmailDomains.some(domain => typeof domain !== 'string' || !/^[a-z0-9.-]+$/i.test(domain)))) throw new Error('OIDC email domains are invalid');
  if (input.autoProvision !== undefined && typeof input.autoProvision !== 'boolean') throw new Error('OIDC autoProvision is invalid');
  const skew = input.clockSkewSeconds === undefined ? 60 : input.clockSkewSeconds;
  if (!Number.isInteger(skew) || skew < 0 || skew > 300) throw new Error('OIDC clock skew is invalid');
  const clientAuth = input.clientAuth || 'client_secret_post';
  if (!['client_secret_post', 'client_secret_basic'].includes(clientAuth)) throw new Error('OIDC client authentication is invalid');
  return { issuer, clientId: input.clientId, clientSecretEnv: input.clientSecretEnv, redirectUri, hosts: input.hosts,
    scopes, tenantId: input.tenantId, allowedEmailDomains: input.allowedEmailDomains?.map(value => value.toLowerCase()),
    autoProvision: input.autoProvision === true, clockSkewSeconds: skew, clientAuth, allowInsecureLoopbackForDevelopment: development };
}

export class OidcProvider {
  static async create(input, options = {}) {
    const config = validateOidcConfig(input, options);
    const provider = new OidcProvider(config, { ...options, secret: options.env?.[config.clientSecretEnv] ?? process.env[config.clientSecretEnv] });
    await provider.discover(true);
    // Load the signing keys now, so a bad key endpoint stops startup and the first sign-in does not spend the
    // once-a-minute allowance meant for unknown key ids.
    await provider.refreshKeys();
    return provider;
  }

  constructor(config, { secret, fetch = pinnedFetch, resolver, clock = () => Date.now() } = {}) {
    this.urlOptions = () => ({ allowInsecureLoopback: config.allowInsecureLoopbackForDevelopment === true, hosts: config.hosts });
    this.config = config; this.secret = secret; this.fetch = fetch; this.resolver = resolver; this.clock = clock;
    this.metadata = null; this.discoveryAt = 0; this.keys = new Map(); this.lastUnknownKidRefresh = -Infinity;
  }

  async request(url, { method = 'GET', headers = {}, body } = {}) {
    const pin = await resolvePinned(url, { hosts: this.config.hosts, allowPrivate: this.config.allowInsecureLoopbackForDevelopment, resolver: this.resolver });
    const response = await this.fetch(pin.url, { address: pin.address, family: pin.family, method, headers, body,
      signal: AbortSignal.timeout(10_000) });
    if (!response?.ok || response.status < 200 || response.status >= 300) throw new Error('OIDC response refused');
    return readBody(response);
  }

  async discover(force = false) {
    if (!force && this.metadata && this.clock() - this.discoveryAt < DISCOVERY_REFRESH_MS) return this.metadata;
    const metadata = await this.request(`${this.config.issuer}/.well-known/openid-configuration`);
    if (!metadata || metadata.issuer !== this.config.issuer) throw new Error('OIDC discovery issuer refused');
    this.metadata = { issuer: metadata.issuer,
      authorizationEndpoint: cleanUrl(metadata.authorization_endpoint, 'authorization endpoint', this.urlOptions()),
      tokenEndpoint: cleanUrl(metadata.token_endpoint, 'token endpoint', this.urlOptions()),
      jwksUri: cleanUrl(metadata.jwks_uri, 'JWKS URI', this.urlOptions()) };
    this.discoveryAt = this.clock();
    return this.metadata;
  }

  async refreshKeys() {
    const metadata = await this.discover();
    const body = await this.request(metadata.jwksUri);
    if (!body || !Array.isArray(body.keys) || body.keys.length > MAX_JWKS_KEYS) throw new Error('OIDC JWKS refused');
    const next = new Map();
    for (const key of body.keys) {
      if (!key || typeof key.kid !== 'string' || key.kid.length > 200 || next.has(key.kid)) continue;
      // `alg` is optional in a JWK (Microsoft Entra omits it). When present it must be one we accept; either way the key
      // type must be one we can verify with, and the token's own algorithm is matched to it at verification time.
      if ((key.alg !== undefined && !['RS256', 'ES256'].includes(key.alg)) || !['sig', undefined].includes(key.use)) continue;
      if (!(key.kty === 'RSA' || (key.kty === 'EC' && key.crv === 'P-256'))) continue;
      if ((key.alg === 'RS256' && key.kty !== 'RSA') || (key.alg === 'ES256' && key.kty !== 'EC')) continue;
      next.set(key.kid, key);
    }
    this.keys = next;
  }

  async exchange({ code, clientId, redirectUri, codeVerifier }) {
    const metadata = await this.discover();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier });
    const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
    if (this.config.clientAuth === 'client_secret_basic') headers.authorization = `Basic ${Buffer.from(`${clientId}:${this.secret}`).toString('base64')}`;
    else { form.set('client_id', clientId); form.set('client_secret', this.secret); }
    return this.request(metadata.tokenEndpoint, { method: 'POST', headers, body: form.toString() });
  }

  async verifyIdToken(token, { nonce } = {}) {
    if (typeof token !== 'string' || token.length > 16_384) throw new Error('OIDC token refused');
    const parts = token.split('.'); if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('OIDC token refused');
    const header = b64json(parts[0]); const claims = b64json(parts[1]);
    if (!header || typeof header !== 'object' || !['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string'
      || header.jku !== undefined || header.x5u !== undefined || header.jwk !== undefined || header.key !== undefined) throw new Error('OIDC token refused');
    await this.discover();
    let jwk = this.keys.get(header.kid);
    if (!jwk && this.clock() - this.lastUnknownKidRefresh >= UNKNOWN_KID_REFRESH_MS) {
      this.lastUnknownKidRefresh = this.clock(); await this.refreshKeys(); jwk = this.keys.get(header.kid);
    }
    // Some providers (Microsoft Entra among them) publish keys without an `alg`. Then the key type must fit the algorithm the
    // token claims, so a token can never pick an algorithm the key was not made for. If `alg` or `use` is present it must agree.
    const fits = jwk && (jwk.alg === undefined || jwk.alg === header.alg) && (jwk.use === undefined || jwk.use === 'sig')
      && (header.alg === 'RS256' ? jwk.kty === 'RSA' : jwk.kty === 'EC' && jwk.crv === 'P-256');
    if (!fits) throw new Error('OIDC token refused');
    let key; try { key = createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw new Error('OIDC token refused'); }
    const signature = Buffer.from(parts[2], 'base64url');
    const valid = verify(header.alg === 'RS256' ? 'RSA-SHA256' : 'sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key,
      header.alg === 'ES256' ? joseEcdsaToDer(signature) : signature);
    if (!valid) throw new Error('OIDC token refused');
    const now = Math.floor(this.clock() / 1000); const skew = this.config.clockSkewSeconds;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.config.issuer || !audience.includes(this.config.clientId)
      || (audience.length > 1 && claims.azp !== this.config.clientId) || !equal(claims.nonce, nonce)
      || typeof claims.sub !== 'string' || !claims.sub || !Number.isInteger(claims.exp) || claims.exp < now - skew
      || !Number.isInteger(claims.nbf ?? now) || claims.nbf > now + skew || !Number.isInteger(claims.iat) || claims.iat > now + skew
      || claims.exp - claims.iat > 60 * 60 || (this.config.tenantId && claims.tid !== this.config.tenantId)) throw new Error('OIDC token refused');
    // A configured domain allowlist cannot be satisfied by a token that carries no email at all.
    if (this.config.allowedEmailDomains && claims.email === undefined) throw new Error('OIDC token refused');
    if (claims.email !== undefined) {
      if (typeof claims.email !== 'string' || claims.email.length > 320 || claims.email_verified !== true) throw new Error('OIDC token refused');
      const domain = claims.email.split('@').at(-1).toLowerCase();
      if (this.config.allowedEmailDomains && !this.config.allowedEmailDomains.includes(domain)) throw new Error('OIDC token refused');
    }
    return claims;
  }

  loginConfig() {
    if (!this.metadata) throw new Error('OIDC discovery unavailable');
    return { issuer: this.config.issuer, clientId: this.config.clientId, redirectUri: this.config.redirectUri,
      authorizationEndpoint: this.metadata.authorizationEndpoint, exchange: request => this.exchange(request),
      verifyIdToken: (token, context) => this.verifyIdToken(token, context), scopes: this.config.scopes,
      autoProvision: this.config.autoProvision, clockSkewSeconds: this.config.clockSkewSeconds,
      allowInsecureLoopbackForDevelopment: this.config.allowInsecureLoopbackForDevelopment };
  }
}
