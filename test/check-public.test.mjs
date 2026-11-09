import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, termHash, windows } from '../scripts/check-public.mjs';

const salt = 'testsalt';
const denylist = { salt, hashes: new Set(['acme tools', 'Zed Corp'].map((t) => termHash(salt, t))) };
const rules = (name, text) => scanText(name, text, denylist).map((f) => f.rule);

test('clean text passes', () => assert.deepEqual(rules('a.md', 'Post a problem, check what exists, write a spec.'), []));
test('denylisted term is caught however it is spelled', () => {
  for (const s of ['Acme Tools', 'acme_tools', 'ACMETOOLS', 'we use acme-tools daily', 'ZED CORP']) assert.deepEqual(rules('a.md', s), ['denylist'], s);
});
test('denylist also checks file names', () => assert.deepEqual(rules('zed-corp-notes.md', 'hello'), ['denylist']));
test('the term itself is not recoverable from the hash list', () => {
  for (const h of denylist.hashes) assert.match(h, /^[0-9a-f]{64}$/);
});
test('secrets, private paths, hosts and personal emails are caught', () => {
  assert.ok(rules('a.js', 'const k = "sk-' + 'a'.repeat(30) + '"').includes('openai-style-key'));
  assert.ok(rules('a.js', 'see /home/' + 'someone/project').includes('private-path'));
  assert.ok(rules('a.md', 'http://box.tail1234.' + 'ts.net').includes('private-network-host'));
  assert.ok(rules('a.md', 'mail me at person@' + 'gmail.com').includes('personal-email'));
  assert.deepEqual(rules('a.md', 'ada@example.com is fine'), []);
});
test('backup and env files are caught but .env.example is allowed', () => {
  assert.ok(rules('config.bak-2026', 'x').includes('forbidden-file'));
  assert.ok(rules('.env', 'x').includes('forbidden-file'));
  assert.deepEqual(rules('.env.example', 'KEY='), []);
});
test('windows joins up to three words', () => assert.ok(windows('Blue Sky Demo').has('blueskydemo')));
