import { createHash, randomBytes } from 'node:crypto';

const base64url = value => Buffer.from(value).toString('base64url');
const random = () => randomBytes(32).toString('base64url');
const sha256 = value => createHash('sha256').update(value).digest('base64url');
const subjectId = (issuer, subject) => `oidc-${createHash('sha256')
  .update(`${issuer}\0${subject}`).digest('hex').slice(0, 32)}`;
const maxPending = 1024;
const validUrl = (value, name) => {
  let url;
  try { url = new URL(value); } catch { throw new Error(`OIDC ${name} must be a URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error(`OIDC ${name} must be a clean HTTPS URL`);
  }
  return url.toString().replace(/\/$/, '');
};

export class OidcLogin {
  constructor(config, { clock = () => Date.now() } = {}) {
    if (!config || typeof config.exchange !== 'function' || typeof config.verifyIdToken !== 'function') {
      throw new Error('OIDC exchange and ID-token verifier required');
    }
    this.issuer = validUrl(config.issuer, 'issuer');
    this.authorizationEndpoint = validUrl(config.authorizationEndpoint, 'authorization endpoint');
    this.redirectUri = validUrl(config.redirectUri, 'redirect URI');
    if (typeof config.clientId !== 'string' || !config.clientId) throw new Error('OIDC client ID required');
    this.clientId = config.clientId;
    this.exchange = config.exchange;
    this.verifyIdToken = config.verifyIdToken;
    this.clock = clock;
    this.pending = new Map();
  }

  begin(binder) {
    if (typeof binder !== 'string' || !binder) throw new Error('OIDC browser binding required');
    this.prune();
    // This endpoint is unauthenticated. Bound ten-minute handshakes so a caller
    // cannot retain arbitrary process memory merely by starting logins.
    if (this.pending.size >= maxPending) throw new Error('too many pending OIDC handshakes');
    const state = random();
    const nonce = random();
    const verifier = random();
    // The raw binder belongs only in the browser's pre-authentication cookie.
    // Keeping a digest here means a pending-login memory disclosure cannot mint
    // a matching browser cookie.
    this.pending.set(state, { nonce, verifier, binderHash: sha256(binder), expires: this.clock() + 10 * 60_000 });
    const url = new URL(this.authorizationEndpoint);
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.clientId,
      redirect_uri: this.redirectUri, scope: 'openid', state, nonce,
      code_challenge: sha256(verifier), code_challenge_method: 'S256' }).toString();
    return url.toString();
  }

  async complete({ state, code, binder }) {
    if (typeof state !== 'string' || typeof code !== 'string' || !code
        || typeof binder !== 'string' || !binder) throw new Error('OIDC response refused');
    const pending = this.pending.get(state);
    // Consume before exchanging, so a provider retry is never a local replay.
    this.pending.delete(state);
    if (!pending || pending.expires <= this.clock() || pending.binderHash !== sha256(binder)) {
      throw new Error('OIDC response refused');
    }
    const response = await this.exchange({ code, clientId: this.clientId,
      redirectUri: this.redirectUri, codeVerifier: pending.verifier });
    if (!response?.id_token) throw new Error('OIDC response refused');
    const claims = await this.verifyIdToken(response.id_token);
    this.validate(claims, pending.nonce);
    return { id: subjectId(this.issuer, claims.sub), issuer: this.issuer, subject: claims.sub };
  }

  validate(claims, nonce) {
    const now = Math.floor(this.clock() / 1000);
    const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
    if (!claims || claims.iss !== this.issuer || !audience.includes(this.clientId)
      || (audience.length > 1 && claims.azp !== this.clientId)
      || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub
      || !Number.isInteger(claims.exp) || claims.exp <= now
      || !Number.isInteger(claims.iat) || claims.iat > now + 60
      || claims.exp - claims.iat > 60 * 60) {
      throw new Error('OIDC token refused');
    }
  }

  prune() {
    const now = this.clock();
    for (const [state, pending] of this.pending) if (pending.expires <= now) this.pending.delete(state);
  }
}

// Test-only provider. It is entirely in process, verifies PKCE, and returns
// claims through the same verifier boundary as a real provider configuration.
export class FakeOidcProvider {
  constructor({ issuer = 'https://idp.example.test', clientId = 'sss-test', clock = () => Date.now() } = {}) {
    this.issuer = issuer;
    this.clientId = clientId;
    this.clock = clock;
    this.codes = new Map();
  }

  configuration(redirectUri) {
    return { issuer: this.issuer, clientId: this.clientId,
      authorizationEndpoint: `${this.issuer}/authorize`, redirectUri,
      exchange: request => this.exchange(request), verifyIdToken: token => this.verify(token) };
  }

  issue({ code = random(), codeChallenge, nonce, subject = 'person', audience = this.clientId,
    issuer = this.issuer, exp, iat, azp } = {}) {
    const now = Math.floor(this.clock() / 1000);
    this.codes.set(code, { codeChallenge, token: base64url(JSON.stringify({ iss: issuer, aud: audience,
      azp, nonce, sub: subject, iat: iat ?? now, exp: exp ?? now + 300 })) });
    return code;
  }

  exchange({ code, clientId, codeVerifier }) {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry || clientId !== this.clientId || sha256(codeVerifier) !== entry.codeChallenge) {
      throw new Error('fake OIDC exchange refused');
    }
    return { id_token: entry.token };
  }

  verify(token) {
    try { return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); }
    catch { throw new Error('fake OIDC token refused'); }
  }
}

