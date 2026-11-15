import { randomUUID } from 'node:crypto';
import { refused } from './errors.js';
import { transaction } from '../worker/control.js';

export function initializeMentoring(store) {
  store.db.exec(`CREATE TABLE mentor_optin(person TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE mentor_requests(id TEXT PRIMARY KEY,requester TEXT NOT NULL,mentor TEXT NOT NULL,
      objective TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE UNIQUE INDEX mentor_open_pair ON mentor_requests(requester,mentor) WHERE status IN ('pending','accepted');
    CREATE TABLE mentor_checkins(id TEXT PRIMARY KEY,request TEXT NOT NULL,actor TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL);
    CREATE TABLE mentor_evidence(id TEXT PRIMARY KEY,request TEXT NOT NULL,owner TEXT NOT NULL,text TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'PRIVATE',shared_with TEXT,revoked_at TEXT,created TEXT NOT NULL);`);
}
const text = (value, max = 2000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const scopes = new Set(['PRIVATE', 'MENTOR_ONLY', 'SPONSOR_SHARED']);

export class Mentoring {
  constructor(store, { clock = Date.now } = {}) { this.store = store; this.db = store.db; this.clock = clock; }
  at() { return new Date(this.clock()).toISOString(); }
  person(id) {
    return typeof id === 'string' && !!this.db.prepare(`SELECT 1 FROM actors a LEFT JOIN person_state p ON p.id=a.id
      WHERE a.id=? AND a.kind='person' AND COALESCE(p.disabled,0)=0`).get(id);
  }
  opted(id) { return this.person(id) && this.db.prepare('SELECT enabled FROM mentor_optin WHERE person=?').get(id)?.enabled === 1; }
  optIn(person, enabled) {
    if (!this.person(person) || typeof enabled !== 'boolean') throw refused('person and explicit mentoring consent required');
    return transaction(this.store, () => {
      this.db.prepare('INSERT INTO mentor_optin VALUES(?,?) ON CONFLICT(person) DO UPDATE SET enabled=excluded.enabled').run(person, enabled ? 1 : 0);
      if (!enabled) {
        this.db.prepare("UPDATE mentor_requests SET status='closed',updated=? WHERE (requester=? OR mentor=?) AND status IN ('pending','accepted')").run(this.at(), person, person);
        this.db.prepare('UPDATE mentor_evidence SET revoked_at=? WHERE owner=? AND revoked_at IS NULL').run(this.at(), person);
      }
    });
  }
  directory(viewer) {
    if (!this.person(viewer)) return [];
    return this.db.prepare(`SELECT o.person FROM mentor_optin o JOIN actors a ON a.id=o.person AND a.kind='person'
      LEFT JOIN person_state p ON p.id=o.person WHERE o.enabled=1 AND COALESCE(p.disabled,0)=0 ORDER BY o.person`).all();
  }
  list(viewer) {
    if (!this.person(viewer)) return [];
    return this.db.prepare('SELECT * FROM mentor_requests WHERE requester=? OR mentor=? ORDER BY created,id').all(viewer, viewer);
  }
  read(viewer, id) {
    if (!this.person(viewer) || typeof id !== 'string') return null;
    return this.db.prepare('SELECT * FROM mentor_requests WHERE id=? AND (requester=? OR mentor=?)').get(id, viewer, viewer) || null;
  }
  request(person, mentor, objective) {
    return transaction(this.store, () => {
      if (!this.opted(person) || !this.opted(mentor) || person === mentor || !text(objective, 500)) throw refused('both people must opt in to mentoring');
      const existing = this.db.prepare("SELECT * FROM mentor_requests WHERE requester=? AND mentor=? AND status IN ('pending','accepted')").get(person, mentor);
      if (existing) { if (existing.objective !== objective) throw refused('an open request already exists'); return existing.id; }
      const id = randomUUID(), at = this.at();
      this.db.prepare("INSERT INTO mentor_requests VALUES(?,?,?,?,'pending',?,?)").run(id, person, mentor, objective, at, at);
      return id;
    });
  }
  decide(person, id, action) {
    return transaction(this.store, () => {
      const row = this.read(person, id);
      if (!row || !['accept', 'decline', 'close'].includes(action)) throw refused('participant decision required');
      if (action !== 'close' && (row.mentor !== person || row.status !== 'pending')) throw refused('only the invited mentor can decide');
      if (action === 'accept' && (!this.opted(row.requester) || !this.opted(row.mentor))) throw refused('mentoring consent withdrawn');
      const status = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'closed';
      this.db.prepare('UPDATE mentor_requests SET status=?,updated=? WHERE id=?').run(status, this.at(), id);
    });
  }
  checkins(viewer, id) {
    if (!this.read(viewer, id)) return [];
    return this.db.prepare('SELECT * FROM mentor_checkins WHERE request=? ORDER BY at,id').all(id);
  }
  checkin(person, id, note) {
    return transaction(this.store, () => {
      const row = this.read(person, id);
      if (!row || row.status !== 'accepted' || !this.opted(row.requester) || !this.opted(row.mentor) || !text(note)) throw refused('accepted, opted-in participants only');
      const key = randomUUID(); this.db.prepare('INSERT INTO mentor_checkins VALUES(?,?,?,?,?)').run(key, id, person, note, this.at()); return key;
    });
  }
  addEvidence(person, id, note, { scope = 'PRIVATE', shared_with = null } = {}) {
    return transaction(this.store, () => {
      const row = this.read(person, id);
      if (!row || row.status !== 'accepted' || !this.opted(person) || !text(note) || !scopes.has(scope)) throw refused('participant evidence and explicit scope required');
      if (scope === 'SPONSOR_SHARED' && (!this.person(shared_with) || shared_with === person)) throw refused('name the person receiving this evidence');
      if (scope !== 'SPONSOR_SHARED' && shared_with !== null) throw refused('a recipient requires explicit sponsor sharing');
      const key = randomUUID(); this.db.prepare('INSERT INTO mentor_evidence VALUES(?,?,?,?,?,?,NULL,?)').run(key, id, person, note, scope, shared_with, this.at()); return key;
    });
  }
  evidence(viewer, id) {
    if (!this.person(viewer) || typeof id !== 'string') return null;
    return this.db.prepare(`SELECT e.* FROM mentor_evidence e JOIN mentor_requests r ON r.id=e.request
      WHERE e.id=? AND (e.owner=? OR (e.revoked_at IS NULL AND
        ((e.scope='MENTOR_ONLY' AND r.mentor=?) OR (e.scope='SPONSOR_SHARED' AND e.shared_with=?))))`).get(id, viewer, viewer, viewer) || null;
  }
  evidenceList(viewer, request) {
    if (!this.read(viewer, request)) return [];
    return this.db.prepare('SELECT id FROM mentor_evidence WHERE request=? ORDER BY created,id').all(request)
      .map(row => this.evidence(viewer, row.id)).filter(Boolean);
  }
  revoke(person, id) {
    return transaction(this.store, () => {
      if (!this.person(person)) throw refused('evidence owner required');
      const row = this.db.prepare('SELECT owner FROM mentor_evidence WHERE id=?').get(id);
      if (!row || row.owner !== person) throw refused('evidence owner required');
      this.db.prepare('UPDATE mentor_evidence SET revoked_at=? WHERE id=?').run(this.at(), id);
    });
  }
}
