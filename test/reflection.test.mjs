import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { itemPage } from '../app/pages.js';
import { reflectionPrompts, loadReflection, saveReflection } from '../public/reflection.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const memoryStorage = () => {
  const values = new Map();
  return { values, get length() { return values.size; }, key: index => [...values.keys()][index] || null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const serialLock = () => { let queue = Promise.resolve(); return (_name, action) => { const run = queue.then(action); queue = run.catch(() => {}); return run; }; };

test('no server route accepts or returns reflection text', async t => {
  const store = new Store(); t.after(() => store.close());
  const auth = new Auth(store); const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
  const call = async (method, url, input) => {
    const req = Readable.from([JSON.stringify(input)]); req.method = method; req.url = url;
    req.headers = { 'content-type': 'application/json' }; req.socket = { remoteAddress: '127.0.0.1' };
    const res = { headers: {}, status: 200, text: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }, end(text = '') { this.text += text; } };
    await handler(req, res); return res;
  };
  const response = await call('POST', '/api/reflection', { text: 'private words must stay here' });
  assert.ok([403, 404].includes(response.status), 'the request is refused before any reflection handler can accept it');
  assert.doesNotMatch(response.text, /private words/);
  const asset = await call('GET', '/assets/reflection.js', {});
  assert.equal(asset.status, 200, 'the browser-only module is a static asset, not an API');
  assert.doesNotMatch(asset.text, /private words/);
  assert.doesNotMatch(source('../app/http.js'), /\/api\/[^'"`\n]*reflection/);
  assert.match(source('../app/http.js'), /GET.*\/assets\/reflection\.js/s);
});

test('decision that went NO then YES shows changed information, never a right or wrong label', () => {
  const prompts = reflectionPrompts({ known: [{ url: 'https://example.test/before', label: 'Before decision' }],
    changed: [{ url: 'https://example.test/after', label: 'Later result' }], later: ['no', 'yes'] });
  assert.match(prompts.known, /https:\/\/example\.test\/before/);
  assert.match(prompts.changed, /https:\/\/example\.test\/after/);
  assert.doesNotMatch(`${prompts.known}\n${prompts.changed}\n${prompts.next}`, /\b(right|wrong)\b/i);
});

test('reflection is browser-only, integrity-checked, and its opt-in never reaches a schema or export', async () => {
  const storage = memoryStorage(), lock = serialLock();
  const initial = await loadReflection(storage, 'author', 'item');
  const saved = await saveReflection(storage, { ...initial.doc, enabled: true,
    notes: { known: 'What I knew.', changed: 'What changed.', next: 'What to ask.' } }, initial.head, lock);
  assert.equal((await loadReflection(storage, 'author', 'item')).doc.notes.next, 'What to ask.');
  assert.match([...storage.values.values()].join('\n'), /What I knew/);
  for (const path of ['../core/store.js', '../core/machine.js', '../intelligence/evidence.js']) {
    assert.doesNotMatch(source(path), /reflection/i, `${path} must not carry browser notes`);
  }
  assert.doesNotMatch(source('../app/pages-mentoring.js'), /private-reflection|sss-reflection/,
    'new code does not read or extend mentoring');
});

test('no endpoint aggregates decisions per person into a score or ranking', () => {
  const http = source('../app/http.js'), pages = source('../app/pages.js');
  assert.doesNotMatch(http, /decision[^\n]{0,120}(score|ranking)|(?:score|ranking)[^\n]{0,120}decision/i);
  assert.doesNotMatch(pages, /decision[^\n]{0,120}(score|ranking)|(?:score|ranking)[^\n]{0,120}decision/i);
});

test('only a decision participant receives the private reflection hook', () => {
  const item = { id: 'item', state: 'SPECCED', context: { rules: 3, steward: 'author', originator: 'author', authors: ['author'], helpers: [], quorum: 2,
    decided: { actor: 'leader', disposition: 'decline', at: '2026-11-16' } } };
  const events = [{ type: 'posted', actor: 'author', original: 'Synthetic issue', body_hash: 'a'.repeat(64) },
    { type: 'decided', actor: 'leader', body_hash: 'b'.repeat(64), evidence: [{ url: 'https://example.test/then', claim: 'Known then' }] },
    { type: 'helped', actor: 'member', body_hash: 'c'.repeat(64), evidence: [{ url: 'https://example.test/later', claim: 'Later result' }] }];
  const author = itemPage(item, events, 'author', false), leader = itemPage(item, events, 'leader', true), member = itemPage(item, events, 'member', false);
  assert.match(author, /id="private-reflection"/); assert.match(leader, /id="private-reflection"/);
  assert.doesNotMatch(member, /id="private-reflection"/);
  assert.match(author, /https:\/\/example\.test\/later/);
});
