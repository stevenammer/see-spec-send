import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanText, scanHistory, termHash, windows } from '../scripts/check-public.mjs';

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

// GitHub's temporary pull-request merge commit carries the PR opener's own email and never lands in the repo.
const commit = (dir, { name, email, committerEmail, message, file }) => {
  writeFileSync(join(dir, file), `${message}\n`);
  const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: committerEmail };
  execFileSync('git', ['-C', dir, 'add', '-A'], { env });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message], { env });
};
const historyRules = (commits) => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-hist-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    for (const c of commits) commit(dir, c);
    return scanHistory(dir, denylist).map((f) => f.rule);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const safe = { name: 'a', email: '1+a@users.noreply.github.com', committerEmail: 'noreply@github.com', file: 'a.txt', message: 'first' };
const sha = 'a'.repeat(40), sha2 = 'b'.repeat(40);
const prMerge = { name: 'Owner', email: 'owner' + '@' + 'gmail.com', committerEmail: 'noreply@github.com', file: 'b.txt', message: `Merge ${sha} into ${sha2}` };

test('history scan: GitHub\'s synthetic PR merge commit is not a leak', () => assert.deepEqual(historyRules([safe, prMerge]), []));
test('history scan: a personal email in a normal commit is still caught', () => {
  assert.deepEqual(historyRules([safe, { ...prMerge, message: 'Fix a thing' }]), ['personal-email']);
});
test('history scan: a lookalike merge not committed by GitHub is still caught', () => {
  assert.deepEqual(historyRules([safe, { ...prMerge, committerEmail: 'someone@users.noreply.github.com' }]), ['personal-email']);
});
test('history scan: a lookalike subject with extra text is still caught', () => {
  assert.deepEqual(historyRules([safe, { ...prMerge, message: `Merge ${sha} into ${sha2} and more` }]), ['personal-email']);
});
