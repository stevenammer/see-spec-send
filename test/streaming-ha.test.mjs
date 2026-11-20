import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the streaming override pins Litestream by digest, hardens it and shares the live data volume', () => {
  const compose = read('compose.streaming.yaml'), digest = read('deploy/litestream.digest').trim();
  assert.match(compose, new RegExp(`image: ${digest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), 'the image is the pinned digest file');
  assert.match(digest, /^litestream\/litestream:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  assert.match(compose, /^ {4}read_only: true$/m);
  assert.match(compose, /^ {4}user: "1000:1000"$/m);
  assert.match(compose, /^ {4}restart: unless-stopped$/m);
  assert.match(compose, /sss-data:\/data$/m);
  assert.doesNotMatch(compose, /ports:|network_mode: host|privileged/);
});

test('the Litestream config replicates the database the server uses, about every second, and bounds how long old data stays', () => {
  const config = read('deploy/litestream.yml');
  assert.match(config, /path: \/data\/sss\.db/);
  assert.match(config, /sync-interval: 1s/);
  const retention = config.match(/retention: (\d+)h/);
  assert.ok(retention && Number(retention[1]) <= 168, 'retention is set and is a week or less');
});

test('the server runs the database in WAL mode, which streaming replication depends on', () => {
  assert.match(read('core/store.js'), /PRAGMA journal_mode=WAL/);
});
