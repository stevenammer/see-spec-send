import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const common = new Set(`password 123456 12345678 123456789 qwerty abc123 111111 1234567 password1
12345 1234567890 000000 letmein welcome monkey dragon football iloveyou admin login
princess solo passw0rd master sunshine ashley bailey shadow superman qazwsx trustno1`.split(/\s+/));
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const now = () => Date.now();
const minute = 60_000;

export class Auth {
  constructor(store, options = {}) {
    this.store = store;
    this.db = store.db;
    this.clock = options.clock || now;
    this.buckets = new Map();
    this.setup();
  }

  setup() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, password TEXT NOT NULL, leader INTEGER NOT NULL DEFAULT 0,
      lock_until INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS invites(
      digest TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions(
      digest TEXT PRIMARY KEY, person TEXT NOT NULL, csrf TEXT NOT NULL, created INTEGER NOT NULL,
      seen INTEGER NOT NULL, expires INTEGER NOT NULL, stepup INTEGER NOT NULL DEFAULT 0,
      stepup_used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS api_tokens(
      digest TEXT PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL
    );`);
  }

  async passwordRecord(password) {
    this.checkPassword(password);
    const salt = randomBytes(16).toString('base64url');
    const n = 16384;
    const r = 8;
    const p = 1;
    const options = { N: n, r, p, maxmem: 32 * 1024 * 1024 };
    const value = await scrypt(password, salt, 64, options);
    return `scrypt$${n}$${r}$${p}$${salt}$${value.toString('base64url')}`;
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
      N: Number(n), r: Number(r), p: Number(p), maxmem: 32 * 1024 * 1024,
    });
    return timingSafeEqual(value, Buffer.from(expected, 'base64url'));
  }

  async createUser(id, password, leader = false) {
    const record = await this.passwordRecord(password);
    this.db.prepare('INSERT INTO users(id,password,leader) VALUES(?,?,?)')
      .run(id, record, leader ? 1 : 0);
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
    if (state.tokens < 1) return false;
    state.tokens -= 1;
    this.buckets.set(key, state);
    return true;
  }

  allowed(ip, account, action = 'login') {
    // Both dimensions stop one address or one account from consuming all attempts.
    return this.take(`${action}:ip:${ip}`) && this.take(`${action}:account:${account}`);
  }

  async redeem(value, id, password, ip = 'local') {
    if (!this.allowed(ip, hash(value), 'invite')) throw new Error('try again later');
    const digest = hash(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare('SELECT * FROM invites WHERE digest=?').get(digest);
      if (!invite || invite.expires <= this.clock()) throw new Error('invite unavailable');
      const changed = this.db.prepare('UPDATE invites SET used=1 WHERE digest=? AND used=0').run(digest);
      if (changed.changes !== 1) throw new Error('invite unavailable');
      const record = await this.passwordRecord(password);
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

  newSession(person) {
    const value = token();
    const csrf = token();
    const time = this.clock();
    const insert = this.db.prepare(`INSERT INTO sessions(digest,person,csrf,created,seen,expires)
      VALUES(?,?,?,?,?,?)`);
    insert.run(hash(value), person, csrf, time, time, time + 8 * 60 * minute);
    return { value, csrf };
  }

  async login(id, password, ip = 'local') {
    if (!this.allowed(ip, id)) throw new Error('login unavailable');
    const user = this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    // Always run scrypt so an unknown id has comparable cost to a bad password.
    const record = user?.password || await this.passwordRecord('not-a-real-password');
    const valid = await this.matches(password, record);
    if (!user || user.lock_until > this.clock() || !valid) {
      if (user) {
        const failures = user.failures + 1;
        const until = this.clock() + Math.min(60 * minute, 1000 * 2 ** failures);
        this.db.prepare('UPDATE users SET failures=?,lock_until=? WHERE id=?').run(failures, until, id);
      }
      throw new Error('login unavailable');
    }
    this.db.prepare('UPDATE users SET failures=0,lock_until=0 WHERE id=?').run(id);
    this.revokePerson(id);
    return this.newSession(id);
  }

  session(value) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE digest=?').get(hash(value));
    if (!row || row.expires <= this.clock() || row.seen + 30 * minute <= this.clock()) {
      return null;
    }
    this.db.prepare('UPDATE sessions SET seen=? WHERE digest=?').run(this.clock(), row.digest);
    return row;
  }

  revoke(value) {
    this.db.prepare('DELETE FROM sessions WHERE digest=?').run(hash(value));
  }

  revokePerson(person) {
    this.db.prepare('DELETE FROM sessions WHERE person=?').run(person);
  }

  async stepup(value, password, ip = 'local') {
    const session = this.session(value);
    if (!session || !this.allowed(ip, session.person, 'stepup')) {
      throw new Error('step-up unavailable');
    }
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

  createToken(kind, item) {
    if (!['gateway', 'run'].includes(kind)) throw new Error('invalid token kind');
    const value = token();
    const insert = this.db.prepare('INSERT INTO api_tokens(digest,kind,item) VALUES(?,?,?)');
    insert.run(hash(value), kind, item);
    this.store.registerToken(hash(value), { kind, item });
    return value;
  }
}
