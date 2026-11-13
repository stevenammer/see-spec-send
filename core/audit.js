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
