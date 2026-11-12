import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { Worker } from '../worker/runner.js';
import { watchdog } from '../worker/watchdog.js';
import { killed } from '../worker/control.js';
import { main } from '../cli.js';
import { emptyQuest, answerQuest, deriveQuest } from '../public/vision-quest.js';
import { portableQuestPrompt, importPortableMemo, preflightQuestModel, draftQuestModel } from '../provider/vision-quest.js';

function quest() {
  let doc = emptyQuest('member');
  const values = { occurrence:'Once', problem:'A repeated problem', chair:'It works around a gap', depends:'A queue', baseline:'Manual work', better:'A small observable test', have:'unavailable', pay_for:'unavailable', free:'unavailable', setting:'unavailable', playback:'yes', priority:'Keep priority', frontline:'Exception', skeptic:'Proof', strongest:'It may fail', first_test:'Try a small list', stop:'Stop on error', owner:'Lead', informed:'Team', risk:'low', reversible:'Turn it off', out_scope:'No adjacent work', impact:'3', repeat:'3', control:'3', evidence:'3', approach:'build' };
  for (const [key, value] of Object.entries(values)) doc = answerQuest(doc, key, value);
  return doc;
}

test('portable Quest prompt imports only the deterministic shared memo', async () => {
  const doc = quest(); const expected = deriveQuest(doc);
  assert.match(portableQuestPrompt(doc), /QUEST=/);
  assert.equal(importPortableMemo(JSON.stringify({ memo: expected }), doc).memo.recommendation, 'BUILD');
  assert.throws(() => importPortableMemo(JSON.stringify({ memo: { ...expected, recommendation: 'KILL' } }), doc), /does not match/);
  const dir = mkdtempSync(join(tmpdir(), 'sss-provider-')); const config = join(dir, 'providers.json');
  writeFileSync(config, JSON.stringify({ providers: [{ name:'local', kind:'command', command:['true'], enabled:true, model:'local', price:{ inputMicrosPerMillion:0, outputMicrosPerMillion:0 } }], defaults:{} }));
  const packet = preflightQuestModel({ providerName:'local', doc }, { SSS_PROVIDERS_FILE: config });
  assert.equal(packet.provider, 'local'); assert.match(packet.label, /Model output/);
  await assert.rejects(draftQuestModel({ providerName:'local', doc, approved:false }, { SSS_PROVIDERS_FILE: config }), /explicit approval/);
});

test('watchdog leaves a fresh install with no run in flight alone, even with no heartbeat', () => {
  const store = new Store(); const now = 1_000_000;
  const result = watchdog(store, { now, heartbeatMs: 10, runMs: 10, outboxMs: 10 });
  assert.equal(result.stopped, false); assert.equal(result.staleHeartbeat, false); assert.equal(killed(store), false);
  store.close();
});

test('watchdog stops stale heartbeat through emergency stop', () => {
  const store = new Store(); const now = 1_000_000;
  store.db.prepare('INSERT INTO worker_heartbeat VALUES(1,?)').run(now - 100);
  // A run is in flight, so the missing heartbeat is a real emergency.
  store.db.prepare("INSERT INTO runs(id,item,approval,spec_hash,run_actor,gateway_actor,status,delivered,started_at) VALUES('r','item',1,'h','a','b','active',0,?)").run(now);
  const result = watchdog(store, { now, heartbeatMs: 10, runMs: 10, outboxMs: 10 });
  assert.equal(result.stopped, true); assert.equal(result.staleHeartbeat, true);
  assert.equal(killed(store), true); assert.ok(store.db.prepare("SELECT 1 FROM worker_history WHERE action='watchdog.stop'").get());
  store.close();
});

test('watchdog stops unrecoverable outbox through emergency stop', () => {
  const store = new Store(); const now = 1_000_000;
  store.db.prepare('INSERT INTO worker_heartbeat VALUES(1,?)').run(now);
  store.db.prepare("INSERT INTO integration_outbox(destination,item,seq,event_type,stage,payload,state,attempts,next_at,created) VALUES('d','i',1,'checked','CHECKED','{}','dead',5,0,?)").run(now - 100);
  const result = watchdog(store, { now, heartbeatMs: 10, runMs: 10, outboxMs: 10 });
  assert.equal(result.stopped, true); assert.equal(result.staleHeartbeat, false); assert.deepEqual(result.unrecoverableOutbox, [1]);
  assert.equal(killed(store), true); assert.ok(store.db.prepare("SELECT 1 FROM worker_history WHERE action='watchdog.stop'").get());
  store.close();
});

test('backup and restore drill keeps a verifiable database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-drill-')); const source = join(dir, 'source.db'); const backup = join(dir, 'backup.db'); const restored = join(dir, 'restore.db');
  let store = new Store(source); store.registerPerson('leader', { leader:true }); store.close();
  await main(['backup', '--to', backup], { SSS_DB: source }, () => {});
  await main(['restore', '--from', backup], { SSS_DB: restored }, () => {});
  assert.equal(existsSync(restored), true); store = new Store(restored); assert.ok(store.verifyAll().every(row => row.ok)); store.close();
});
