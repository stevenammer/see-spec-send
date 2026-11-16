import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { researchRecord } from '../research/connectors.js';
import { searchKnowledge } from '../knowledge/index.js';
import { writeBackup, restoreBackup } from '../core/backup.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const at = '2026-11-16T12:00:00.000Z';

test('disconnected research source stays labeled not connected in the index', async () => {
  const store = new Store();
  try {
    store.registerPerson('maya');
    store.append('research', { type: 'posted', actor: 'maya', rules: 2, original: 'Find the export owner.', at }, { idem: 'post' });
    const sources = await researchRecord({ at, input: { text: 'export owner' }, connectors: { 'internal prior work': () => 'Checked record', 'open source': () => '', 'commercial options': () => '' } });
    store.append('research', { type: 'researched', actor: 'maya', sources, at }, { idem: 'research' });
    const rows = searchKnowledge(store, 'maya', 'nothing checked');
    const row = rows.find(entry => entry.source_name === 'process change');
    assert.equal(row.type, 'research'); assert.equal(row.connected, false);
  } finally { store.close(); }
});

test('restore from an older backup does not revive retracted annexes or old approvals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-s5-backup-'));
  const file = join(dir, 'live.sqlite'), backup = join(dir, 'older.sqlite'), restored = join(dir, 'restored.sqlite');
  const store = new Store(file);
  try {
    store.registerPerson('maya');
    store.append('case', { type: 'posted', actor: 'maya', rules: 3, original: 'Export loses notes.', at }, { idem: 'post' });
    const source = store.events('case')[0].body_hash;
    const delta = store.knowledge.append('delta', { v: 1, source: { item: 'case', body_hash: source }, claims: [{ text: 'note' }] }, { at });
    const annex = store.knowledge.append('annex', { v: 1, parent: { item: 'case' }, delta: delta.hash }, { at });
    store.db.prepare('INSERT INTO knowledge_tombstones(target_hash,reason,source_body_hash,at) VALUES(?,?,?,?)').run(annex.hash, 'privacy', source, at);
    writeBackup(store, backup);
    // The backup is now older than further live history, but it already carries
    // the retraction. Restoring it must not make derived support actionable.
    store.knowledge.append('receipt', { v: 1, kind: 'later_live_history' }, { at });
    store.close();
    restoreBackup(backup, restored);
    const recovered = new Store(restored);
    try {
      assert.equal(recovered.knowledge.entries('annex')[0].erased, true);
      assert.equal(recovered.read('case').context.approval, 0, 'no old approval is recreated by derived-memory replay');
    } finally { recovered.close(); }
  } finally { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});
