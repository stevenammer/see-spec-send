import { createHash } from 'node:crypto';

// One row per state-changing CLI command. Each row seals its own fields and the previous seal,
// so an edited, deleted, or reordered row breaks the chain that `verify` checks.
const GENESIS = '0'.repeat(64);
const seal = (previous, row) => createHash('sha256')
  .update(`${previous}\n${JSON.stringify([row.at, row.command, row.outcome, row.detail])}`).digest('hex');

export const AUDIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS admin_audit(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, command TEXT NOT NULL,
    outcome TEXT NOT NULL, detail TEXT NOT NULL, prev TEXT NOT NULL, seal TEXT NOT NULL
  );`;

// Created on first use by an admin command. It is not a schema migration, so the version stays put.
export function appendAudit(db, { at, command, outcome, detail = '{}' }) {
  db.exec(AUDIT_SCHEMA);
  const previous = db.prepare('SELECT seal FROM admin_audit ORDER BY seq DESC LIMIT 1').get()?.seal ?? GENESIS;
  const row = { at, command, outcome, detail };
  db.prepare('INSERT INTO admin_audit(at,command,outcome,detail,prev,seal) VALUES(?,?,?,?,?,?)')
    .run(at, command, outcome, detail, previous, seal(previous, row));
}

export function verifyAudit(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_audit'").get()) return { ok: true, rows: 0 };
  const rows = db.prepare('SELECT * FROM admin_audit ORDER BY seq').all();
  let previous = GENESIS;
  for (const row of rows) {
    if (row.prev !== previous || row.seal !== seal(previous, row)) {
      return { ok: false, rows: rows.length, reason: `audit row ${row.seq} does not match its seal` };
    }
    previous = row.seal;
  }
  return { ok: true, rows: rows.length };
}

// SIEM exports expose sealed administrative facts only. Detail is selected CLI
// identifiers, never request bodies, credentials, or tokens.
export function auditRows(db, since = null) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_audit'").get()) return [];
  const rows = db.prepare('SELECT seq,at,command,outcome,detail,seal FROM admin_audit WHERE (? IS NULL OR at >= ?) ORDER BY seq').all(since, since);
  return rows.map(row => ({ timestamp: row.at, who: (() => { try { return JSON.parse(row.detail).actor || 'cli'; } catch { return 'cli'; } })(), what: row.command, outcome: row.outcome, detail: JSON.parse(row.detail), sequence: row.seq, seal: row.seal }));
}

export function formatAudit(rows, format = 'jsonl') {
  if (format === 'jsonl') return rows.map(row => JSON.stringify(row)).join(rows.length ? '\n' : '') + (rows.length ? '\n' : '');
  if (format !== 'cef') throw new Error('audit format must be jsonl or cef');
  const esc = value => String(value ?? '').replace(/([\\=|])/g, '\\$1').replace(/\r?\n/g, ' ');
  return rows.map(row => `CEF:0|See Spec Send|audit|1|${esc(row.what)}|${esc(row.what)}|3 rt=${esc(row.timestamp)} suser=${esc(row.who)} outcome=${esc(row.outcome)} cs1Label=sequence cs1=${row.sequence}`).join(rows.length ? '\n' : '') + (rows.length ? '\n' : '');
}
