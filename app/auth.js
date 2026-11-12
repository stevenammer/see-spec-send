import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
// Entries of 12 or more characters matter: the policy's length floor is 12, so shorter entries never reach the check.
const common = new Set(`password 123456 12345678 123456789 qwerty abc123 111111 1234567 password1
12345 1234567890 000000 letmein welcome monkey dragon football iloveyou admin login
princess solo passw0rd master sunshine ashley bailey shadow superman qazwsx trustno1
password1234 password12345 iloveyou1234 letmein123456 welcome123456 changeme1234
qwertyuiop12 monkey1234567 football12345 superman12345 sunshine12345 passw0rd1234
administrator`.split(/\s+/));
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const now = () => Date.now();
const minute = 60_000;
const failureWindow = 15 * minute;
const accountFailureCeiling = 30;
// New hashes use the current cost. Older records keep verifying and are re-hashed on their next good login.
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
// Failure rows are bounded so a flood of invented IDs cannot grow the table without limit.
const failureRowCap = 100_000;
// An unknown ID gets one scrypt run at the current cost, the same as a real account. It can never match.
const decoyRecord = () => `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${randomBytes(16).toString('base64url')}$${randomBytes(64).toString('base64url')}`;
const validAccountId = value => typeof value === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(value)
  && !value.startsWith('source:') && !value.startsWith('oidc-') && !/^[a-f0-9]{64}$/.test(value);

export class Auth {
  constructor(store, options = {}) {
    this.store = store;
    this.db = store.db;
    this.clock = options.clock || now;
    this.oidc = options.oidc || null;
    this.buckets = new Map();
    this.setup();
  }

  setup() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, password TEXT NOT NULL, leader INTEGER NOT NULL DEFAULT 0,
      lock_until INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS login_failures(
      account TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_failures_account ON login_failures(account, at);
    CREATE TABLE IF NOT EXISTS invites(
      digest TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions(
      digest TEXT PRIMARY KEY, person TEXT NOT NULL, csrf TEXT NOT NULL, created INTEGER NOT NULL,
      seen INTEGER NOT NULL, expires INTEGER NOT NULL, stepup INTEGER NOT NULL DEFAULT 0,
      stepup_used INTEGER NOT NULL DEFAULT 0, auth_method TEXT NOT NULL DEFAULT 'password',
      review_item TEXT, review_spec_hash TEXT, review_seq INTEGER
    );
    CREATE TABLE IF NOT EXISTS api_tokens(
      digest TEXT PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_state(
      id TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0
    );`);
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'"); } catch {}
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN review_item TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN review_spec_hash TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN review_seq INTEGER'); } catch {}
    // must_change: the password on record is temporary (init or a reset code) and must be replaced.
    // temp_used: that temporary password has already signed someone in, so it cannot sign in again.
    this.addColumn('users', 'must_change', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('users', 'temp_used', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('invites', 'revoked', 'INTEGER NOT NULL DEFAULT 0');
  }

  // Only adds a column that is missing. Any other failure still surfaces.
  addColumn(table, column, definition) {
    const present = this.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
    if (!present) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  // The record format is scrypt$N$r$p$salt$value. This never applies the password policy.
  async record(password) {
    const salt = randomBytes(16).toString('base64url');
    const value = await scrypt(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${value.toString('base64url')}`;
  }

  async passwordRecord(password) {
    this.checkPassword(password);
    return this.record(password);
  }

  checkPassword(password) {
    if (typeof password !== 'string' || password.length < 12
      || common.has(password.toLowerCase())) {
      throw new Error('password does not meet policy');
    }
  }

  async matches(password, record) {
    const [kind, n, r, p, salt, expected] = String(record).split('$');
    if (kind !== 'scrypt') return false;
    const value = await scrypt(password, salt, 64, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
    });
    return timingSafeEqual(value, Buffer.from(expected, 'base64url'));
  }

  async createUser(id, password, leader = false, { mustChange = false } = {}) {
    if (!validAccountId(id)) throw new Error('invalid account id');
    if (this.db.prepare('SELECT 1 FROM users WHERE lower(id)=lower(?)').get(id)) throw new Error('account id exists');
    const record = await this.passwordRecord(password);
    this.db.prepare('INSERT INTO users(id,password,leader,must_change) VALUES(?,?,?,?)')
      .run(id, record, leader ? 1 : 0, mustChange ? 1 : 0);
    this.store.registerPerson(id, { leader });
  }

  createInvite(role, expires = this.clock() + 24 * 60 * minute) {
    if (!['member', 'leader'].includes(role)) throw new Error('invalid invite role');
    const value = token();
    this.db.prepare('INSERT INTO invites(digest,role,expires) VALUES(?,?,?)')
      .run(hash(value), role, expires);
    return value;
  }

  take(key) {
    const state = this.buckets.get(key) || { tokens: 5, at: this.clock() };
    const elapsed = this.clock() - state.at;
    state.tokens = Math.min(5, state.tokens + elapsed / minute);
    state.at = this.clock();
    // Re-insert so the map stays in least-recently-used order for pruning.
    this.buckets.delete(key);
    this.buckets.set(key, state);
    if (this.buckets.size > 10_000) this.prune();
    if (state.tokens < 1) return false;
    state.tokens -= 1;
    return true;
  }

  prune() {
    const cutoff = this.clock() - 5 * minute;
    for (const [key, state] of this.buckets) if (state.at < cutoff) this.buckets.delete(key);
    // Hard cap: attacker-chosen identities can never grow this map without bound.
    while (this.buckets.size > 50_000) this.buckets.delete(this.buckets.keys().next().value);
  }

  loginBlocked(id, ip) {
    const now = this.clock();
    this.db.prepare('DELETE FROM login_failures WHERE at<?').run(now - failureWindow);
    const pair = this.db.prepare(
      'SELECT count(*) AS n, max(at) AS last FROM login_failures WHERE account=? AND ip=?',
    ).get(id, ip);
    // Lockout is per address, so a stranger's failures can never lock the owner out.
    if (pair.n > 0 && pair.last + Math.min(failureWindow, 1000 * 2 ** pair.n) > now) return true;
    const account = this.db.prepare('SELECT count(*) AS n FROM login_failures WHERE account=?').get(id);
    // Spread-out guessing hits a high ceiling that expires by itself.
    return account.n >= accountFailureCeiling;
  }

  allowed(ip, account, action = 'login') {
    // Both dimensions stop one address or one account from consuming all attempts.
    return this.take(`${action}:ip:${ip}`) && this.take(`${action}:account:${account}`);
  }

  async redeem(value, id, password, ip = 'local') {
    if (!validAccountId(id)) throw new Error('invalid account id');
    const existing = this.db.prepare('SELECT id FROM users WHERE lower(id)=lower(?)').get(id);
    // Leave an exact duplicate to the INSERT below. That preserves the no-transaction-during-
    // password-work guarantee while still refusing case-variant identities before redemption.
    if (existing && existing.id !== id) throw new Error('account id exists');
    if (!this.allowed(ip, hash(value), 'invite')) throw new Error('try again later');
    const digest = hash(value);
    // Password work must finish before the transaction so other requests stay isolated.
    const record = await this.passwordRecord(password);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare('SELECT * FROM invites WHERE digest=?').get(digest);
      if (!invite || invite.expires <= this.clock() || invite.revoked === 1) throw new Error('invite unavailable');
      const changed = this.db.prepare('UPDATE invites SET used=1 WHERE digest=? AND used=0').run(digest);
      if (changed.changes !== 1) throw new Error('invite unavailable');
      this.db.prepare('INSERT INTO users(id,password,leader) VALUES(?,?,?)')
        .run(id, record, invite.role === 'leader' ? 1 : 0);
      this.store.registerPerson(id, { leader: invite.role === 'leader' });
      this.db.exec('COMMIT');
      return this.newSession(id);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  newSession(person, authMethod = 'password') {
    const value = token();
    const csrf = token();
    const time = this.clock();
    const insert = this.db.prepare(`INSERT INTO sessions(digest,person,csrf,created,seen,expires,auth_method)
      VALUES(?,?,?,?,?,?,?)`);
    insert.run(hash(value), person, csrf, time, time, time + 8 * 60 * minute, authMethod);
    return { value, csrf };
  }

  beginOidc(binder) {
    if (!this.oidc) throw new Error('OIDC unavailable');
    return this.oidc.begin(binder);
  }

  async completeOidc(response) {
    if (!this.oidc) throw new Error('OIDC unavailable');
    const identity = await this.oidc.complete(response);
    if (this.isDisabled(identity.id)) throw new Error('person disabled');
    // Claims never change an existing local account or grant leadership. An
    // administrator may promote the opaque mapped ID through the normal path.
    try {
      const actor = this.store.actor(identity.id, '');
      if (actor.kind !== 'person') throw new Error('OIDC identity collision');
    } catch (error) {
      if (error.message !== 'unknown actor') throw error;
      this.store.registerPerson(identity.id, { leader: false });
    }
    this.revokePerson(identity.id);
    return this.newSession(identity.id, 'oidc');
  }

  async login(id, password, ip = 'local') {
    if (!this.take(`login:ip:${ip}`) || typeof id !== 'string' || this.loginBlocked(id, ip)) {
      throw new Error('login unavailable');
    }
    const user = this.db.prepare(`SELECT u.*, coalesce(p.disabled, 0) AS disabled
      FROM users u LEFT JOIN person_state p ON p.id=u.id WHERE u.id=?`).get(id);
    // Every ID, known or not, runs exactly one scrypt at the current cost before any decision.
    const record = user?.password || decoyRecord();
    const valid = await this.matches(password, record);
    const temporaryUsed = user?.must_change === 1 && user?.temp_used === 1;
    if (!user || !valid || user.disabled === 1 || temporaryUsed) {
      // Known and unknown IDs get the same failure row, so lockout and pruning behave the same.
      this.recordFailure(id, ip);
      throw new Error('login unavailable');
    }
    if (!record.startsWith(`scrypt$${SCRYPT_N}$`)) await this.rehash(user, password);
    this.db.prepare('DELETE FROM login_failures WHERE account=? AND ip=?').run(id, ip);
    if (user.must_change === 1) this.db.prepare('UPDATE users SET temp_used=1 WHERE id=?').run(id);
    this.revokePerson(id);
    return this.newSession(id);
  }

  recordFailure(id, ip) {
    this.db.prepare('INSERT INTO login_failures(account,ip,at) VALUES(?,?,?)').run(id, ip, this.clock());
    const { n } = this.db.prepare('SELECT count(*) AS n FROM login_failures').get();
    const excess = n - failureRowCap;
    if (excess > 0) {
      this.db.prepare(`DELETE FROM login_failures WHERE rowid IN
        (SELECT rowid FROM login_failures ORDER BY at ASC LIMIT ?)`).run(excess);
    }
  }

  async rehash(user, password) {
    const next = await this.record(password);
    this.db.prepare('UPDATE users SET password=? WHERE id=? AND password=?').run(next, user.id, user.password);
  }

  session(value) {
    const row = this.db.prepare(`SELECT s.*, coalesce(p.disabled, 0) AS disabled, coalesce(u.must_change, 0) AS must_change
      FROM sessions s LEFT JOIN person_state p ON p.id=s.person LEFT JOIN users u ON u.id=s.person
      WHERE s.digest=?`).get(hash(value));
    if (!row || row.disabled === 1 || row.expires <= this.clock() || row.seen + 30 * minute <= this.clock()) {
      return null;
    }
    this.db.prepare('UPDATE sessions SET seen=? WHERE digest=?').run(this.clock(), row.digest);
    return row;
  }

  isDisabled(person) {
    return this.db.prepare('SELECT disabled FROM person_state WHERE id=?').get(person)?.disabled === 1;
  }

  revoke(value) {
    this.db.prepare('DELETE FROM sessions WHERE digest=?').run(hash(value));
  }

  revokePerson(person) {
    this.db.prepare('DELETE FROM sessions WHERE person=?').run(person);
  }

  // A person changes their own password with a fresh step-up. The step-up is consumed, every
  // session for the person ends, and the caller gets one new session.
  async changePassword(value, password) {
    this.checkPassword(password);
    const session = this.session(value);
    if (!session || !this.useStepup(value)) throw new Error('step-up unavailable');
    const record = await this.record(password);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare('UPDATE users SET password=?, must_change=0, temp_used=0 WHERE id=?')
        .run(record, session.person).changes;
      if (changed !== 1) throw new Error('step-up unavailable');
      this.revokePerson(session.person);
      const next = this.newSession(session.person);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  // Administrator actions. Each one is a CLI command; none is reachable over HTTP.
  listPeople() {
    return this.db.prepare(`SELECT a.id, a.leader, coalesce(p.disabled, 0) AS disabled,
      coalesce(u.must_change, 0) AS must_change
      FROM actors a LEFT JOIN person_state p ON p.id=a.id LEFT JOIN users u ON u.id=a.id
      WHERE a.kind='person' ORDER BY a.id`).all();
  }

  requirePerson(id) {
    const row = this.db.prepare('SELECT kind FROM actors WHERE id=?').get(id);
    if (!row || row.kind !== 'person') throw new Error('unknown person');
  }

  // Refuses the change when it would leave no enabled leader. Called before demoting or disabling.
  guardLeader(id) {
    const actor = this.db.prepare("SELECT leader FROM actors WHERE id=? AND kind='person'").get(id);
    if (!actor || actor.leader !== 1) return;
    const others = this.db.prepare(`SELECT count(*) AS n FROM actors a
      WHERE a.kind='person' AND a.leader=1 AND a.id<>?
      AND NOT EXISTS (SELECT 1 FROM person_state p WHERE p.id=a.id AND p.disabled=1)`).get(id).n;
    if (others < 1) throw new Error('at least one enabled leader must remain');
  }

  setDisabled(id, disabled) {
    this.requirePerson(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (disabled) {
        this.guardLeader(id);
        this.revokePerson(id);
      }
      this.db.prepare(`INSERT INTO person_state(id,disabled) VALUES(?,?)
        ON CONFLICT(id) DO UPDATE SET disabled=excluded.disabled`).run(id, disabled ? 1 : 0);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  disablePerson(id) { this.setDisabled(id, true); }

  enablePerson(id) { this.setDisabled(id, false); }

  setLeader(id, leader) {
    this.requirePerson(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!leader) this.guardLeader(id);
      this.store.registerPerson(id, { leader });
      this.db.prepare('UPDATE users SET leader=? WHERE id=?').run(leader ? 1 : 0, id);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  // Returns a new temporary password (single-use, forces a change) and ends the person's sessions.
  async resetPerson(id) {
    const user = this.db.prepare('SELECT id FROM users WHERE id=?').get(id);
    if (!user) throw new Error('unknown person');
    const code = `Reset-${randomBytes(18).toString('base64url')}-9a`;
    const record = await this.record(code);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE users SET password=?, must_change=1, temp_used=0 WHERE id=?').run(record, id);
      this.db.prepare('DELETE FROM login_failures WHERE account=?').run(id);
      this.revokePerson(id);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return code;
  }

  // Shows a prefix of each invite's digest. The token itself is never stored or listed.
  listInvites() {
    const current = this.clock();
    return this.db.prepare('SELECT digest, role, expires, used, revoked FROM invites ORDER BY expires, digest').all()
      .map(row => ({ id: row.digest.slice(0, 12), role: row.role, expires: row.expires,
        status: row.revoked === 1 ? 'revoked' : row.used === 1 ? 'used'
          : row.expires <= current ? 'expired' : 'open' }));
  }

  revokeInvite(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{12,64}$/.test(id)) {
      throw new Error('invite id must be at least 12 hex characters');
    }
    const matches = this.db.prepare('SELECT digest, used, revoked FROM invites WHERE substr(digest,1,?)=?').all(id.length, id);
    if (matches.length !== 1) throw new Error('invite id matches no invite or more than one');
    const [invite] = matches;
    if (invite.used === 1 || invite.revoked === 1) throw new Error('invite is not open');
    if (this.db.prepare('UPDATE invites SET revoked=1 WHERE digest=? AND used=0 AND revoked=0').run(invite.digest).changes !== 1) {
      throw new Error('invite is not open');
    }
    return { id: invite.digest.slice(0, 12), status: 'revoked' };
  }

  async stepup(value, password, ip = 'local') {
    const session = this.session(value);
    if (!session || !this.allowed(ip, session.person, 'stepup')) {
      throw new Error('step-up unavailable');
    }
    if (session.auth_method !== 'password') throw new Error('step-up unavailable');
    const user = this.db.prepare('SELECT password FROM users WHERE id=?').get(session.person);
    if (!user || !await this.matches(password, user.password)) throw new Error('step-up unavailable');
    this.db.prepare('UPDATE sessions SET stepup=?,stepup_used=0 WHERE digest=?')
      .run(this.clock(), hash(value));
  }

  useStepup(value) {
    const row = this.session(value);
    // Approval needs recent proof and consumes it so a captured session cannot replay approval.
    if (!row || row.stepup + 5 * minute < this.clock()) return false;
    const update = this.db.prepare('UPDATE sessions SET stepup_used=1 WHERE digest=? AND stepup_used=0');
    return update.run(hash(value)).changes === 1;
  }

  hasStepup(value) {
    const row = this.session(value);
    return Boolean(row && row.stepup + 5 * minute >= this.clock() && row.stepup_used === 0);
  }

  reviewApproval(value, item, specHash, seq) {
    const row = this.session(value);
    if (!row) return false;
    return this.db.prepare('UPDATE sessions SET review_item=?,review_spec_hash=?,review_seq=? WHERE digest=?')
      .run(item, specHash, seq, hash(value)).changes === 1;
  }

  approvalReview(value, item) {
    const row = this.session(value);
    if (!row || row.review_item !== item) return null;
    return { specHash: row.review_spec_hash, seq: row.review_seq };
  }

  createToken(kind, item) {
    if (!['gateway', 'run'].includes(kind)) throw new Error('invalid token kind');
    const value = token();
    const insert = this.db.prepare('INSERT INTO api_tokens(digest,kind,item) VALUES(?,?,?)');
    insert.run(hash(value), kind, item);
    this.store.registerToken(hash(value), { kind, item });
    return value;
  }
}
