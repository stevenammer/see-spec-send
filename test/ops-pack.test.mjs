import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { appendAudit, auditRows, formatAudit } from '../core/audit.js';

test('audit exports sealed metadata as JSONL and CEF without details leaking into CEF', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sss-audit-')), 'db.sqlite'));
  appendAudit(store.db, { at: '2026-01-01T00:00:00.000Z', command: 'erase', outcome: 'ok', detail: '{"--item":"x"}' });
  const rows = auditRows(store.db); assert.match(formatAudit(rows), /"what":"erase"/); assert.match(formatAudit(rows, 'cef'), /^CEF:0\|/); assert.doesNotMatch(formatAudit(rows, 'cef'), /--item/); store.close();
});

test('generated route table is current and container is hardened by inspection', () => {
  assert.match(readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8'), /USER node/);
  assert.match(readFileSync(new URL('../app/http.js', import.meta.url), 'utf8'), /flag: 'a'/);
  assert.match(readFileSync(new URL('../docs/ROUTE_TABLE.md', import.meta.url), 'utf8'), /Body cap/);
});
