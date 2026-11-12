import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { checkedUrl, redact } from '../provider/safe-http.js';

const WINDOW = 5 * 60_000;
const text = value => typeof value === 'string' && value.length > 0;
const signature = (secret, timestamp, bytes) => createHmac('sha256', secret).update(`${timestamp}.`).update(bytes).digest('hex');
const equal = (left, right) => {
  const a = Buffer.from(left || ''); const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
};
const validName = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
const strictSeen = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Object.keys(value).every(key => ['problem', 'source_label', 'honesty_label'].includes(key))
      || !text(value.problem) || value.problem.length > 2000
      || !text(value.source_label) || value.source_label.length > 120
      || !['observed', 'reported', 'documented'].includes(value.honesty_label)) throw Error('invalid inbound schema');
  return value;
};
const safeError = error => redact(String(error?.message || 'delivery failed')).slice(0, 300);

export class Integrations {
  constructor(store, { clock = () => Date.now(), fetcher = fetch, origin = 'https://localhost' } = {}) {
    this.store = store; this.db = store.db; this.clock = clock; this.fetcher = fetcher; this.origin = origin;
    this.buckets = new Map();
  }

  addSource(name, secret, rateLimit = 30) {
    if (!validName(name) || !text(secret) || secret.length < 16 || !Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 600) throw Error('invalid integration source');
    this.db.prepare('INSERT INTO integration_sources(name,secret,rate_limit) VALUES(?,?,?)').run(name, secret, rateLimit);
    this.store.registerSource(`source:${name}`);
  }

  addDestination(name, url, secret, { includeText = false, allowLoopback = false } = {}) {
    if (!validName(name) || !text(secret) || secret.length < 16) throw Error('invalid integration destination');
    let parsed; try { parsed = new URL(url); } catch { throw Error('invalid destination URL'); }
    if (parsed.protocol !== 'https:' && !(allowLoopback && parsed.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname))) throw Error('HTTPS destination required');
    if (parsed.username || parsed.password || parsed.hash || parsed.search) throw Error('invalid destination URL');
    this.db.prepare('INSERT INTO integration_destinations(name,url,secret,include_text,allow_loopback) VALUES(?,?,?,?,?)')
      .run(name, parsed.toString(), secret, includeText ? 1 : 0, allowLoopback ? 1 : 0);
  }

  list(kind) {
    if (kind === 'source') return this.db.prepare('SELECT name,enabled,rate_limit FROM integration_sources ORDER BY name').all();
    if (kind === 'destination') return this.db.prepare('SELECT name,url,include_text,enabled,allow_loopback FROM integration_destinations ORDER BY name').all();
    throw Error('unknown integration kind');
  }

  allowed(source) {
    const now = this.clock(); const row = this.buckets.get(source) || { tokens: null, at: now };
    const limit = this.db.prepare('SELECT rate_limit FROM integration_sources WHERE name=?').get(source)?.rate_limit;
    if (!limit) return false;
    row.tokens = row.tokens === null ? limit : Math.min(limit, row.tokens + (now - row.at) * limit / 60_000);
    row.at = now; this.buckets.set(source, row);
    if (row.tokens < 1) return false; row.tokens -= 1; return true;
  }

  receive(source, timestamp, supplied, bytes, headers = {}) {
    const row = this.db.prepare('SELECT * FROM integration_sources WHERE name=? AND enabled=1').get(source);
    const time = Number(timestamp);
    if (!row || !Number.isSafeInteger(time) || Math.abs(this.clock() - time) > WINDOW || !equal(signature(row.secret, timestamp, bytes), String(supplied || '').replace(/^sha256=/, '')) || !this.allowed(source)) throw Error('inbound refused');
    let input; try { input = strictSeen(JSON.parse(bytes.toString('utf8'))); } catch { throw Error('inbound refused'); }
    const idem = headers['idempotency-key'];
    if (!text(idem) || idem.length > 160) throw Error('inbound refused');
    const replay = createHash('sha256').update(`${timestamp}\0${supplied}\0${idem}`).digest('hex');
    const item = randomBytes(24).toString('base64url');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM integration_replays WHERE expires<=?').run(this.clock());
      const accepted = this.db.prepare('INSERT OR IGNORE INTO integration_replays(source,digest,expires) VALUES(?,?,?)').run(source, replay, this.clock() + WINDOW);
      if (accepted.changes !== 1) throw Error('inbound refused');
      this.store.appendInTransaction(item, { type: 'seen', actor: `source:${source}`, at: new Date(this.clock()).toISOString(), ...input }, { idem: `inbound:${source}:${idem}` });
      this.db.exec('COMMIT'); return { id: item };
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  async deliverOnce() {
    const row = this.db.prepare(`SELECT o.*,d.url,d.secret,d.allow_loopback FROM integration_outbox o JOIN integration_destinations d ON d.name=o.destination
      WHERE o.state='pending' AND o.next_at<=? AND d.enabled=1 ORDER BY o.id LIMIT 1`).get(this.clock());
    if (!row) return false;
    const claim = this.db.prepare("UPDATE integration_outbox SET state='sending' WHERE id=? AND state='pending'").run(row.id);
    if (claim.changes !== 1) return false;
    const bytes = Buffer.from(row.payload); const timestamp = String(this.clock());
    try {
      const url = await checkedUrl(row.url, { hosts: [new URL(row.url).hostname], allowPrivate: row.allow_loopback === 1 });
      const response = await this.fetcher(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-sss-timestamp': timestamp, 'x-sss-signature': `sha256=${signature(row.secret, timestamp, bytes)}`, 'idempotency-key': `outbox-${row.id}` }, body: bytes, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw Error(`destination HTTP ${response.status}`);
      this.db.prepare("UPDATE integration_outbox SET state='delivered',delivered=?,last_error=NULL WHERE id=?").run(this.clock(), row.id);
    } catch (error) {
      const attempts = row.attempts + 1; const state = attempts >= 5 ? 'dead' : 'pending';
      this.db.prepare('UPDATE integration_outbox SET state=?,attempts=?,next_at=?,last_error=? WHERE id=?')
        .run(state, attempts, this.clock() + Math.min(60 * 60_000, 1000 * 2 ** attempts), safeError(error), row.id);
    }
    return true;
  }

  outbox() { return this.db.prepare('SELECT id,destination,item,seq,event_type,stage,state,attempts,next_at,created,delivered,last_error FROM integration_outbox ORDER BY id').all(); }
}

export const hmac = signature;
