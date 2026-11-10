import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { itemPage } from '../app/pages.js';
import { STEPS, answerQuest, checkedFromQuest, deriveQuest, emptyQuest } from '../public/vision-quest.js';
import { loadDraft, openQuest, restoreDraft, saveDraft } from '../public/quest-storage.js';
import { completedQuest } from './helpers/quest-fixture.mjs';

const item = () => ({ id: 'a', state: 'CHECKED',
  context: { steward: 'maker', helpers: [], quorum: 2, ineligibleHelpers: [] } });
const pass = 'synthetic-long-passphrase-7';
async function call(handler, method, url, input, headers = {}, raw) {
  const req = Readable.from(raw !== undefined ? [raw] : input === undefined ? [] : [JSON.stringify(input)]);
  req.method = method;
  req.url = url;
  const typed = input === undefined && raw === undefined ? {} : { 'content-type': 'application/json' };
  req.headers = { ...typed, ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = { headers: {}, text: '', setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, values = {}) { this.status = status; Object.assign(this.headers, values); },
    end(text = '') { this.text += text; } };
  await handler(req, res);
  return { ...res, json: res.headers['content-type']?.includes('json') && res.text ? JSON.parse(res.text) : null };
}
async function world(...people) {
  const store = new Store();
  const auth = new Auth(store);
  const handler = createHandler({ store, auth });
  const who = {};
  for (const [id, leader] of people) {
    await auth.createUser(id, pass, leader);
    const login = await call(handler, 'POST', '/api/login', { id, password: pass });
    who[id] = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'https://localhost',
      'x-csrf-token': login.json.csrf };
  }
  return { store, handler, who };
}
const storage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key) };
};
const lock = async (_name, action) => action();

test('authority: a quest can only post what its signed-in person could post by hand', async () => {
  const { store, handler, who } = await world(['maker', false], ['boss', true]);
  try {
    const quest = completedQuest({}, 'maker');
    // It cannot act for another person, with or without a forged actor beside it.
    for (const as of ['boss']) {
      const res = await call(handler, 'POST', '/api/items', { quest }, who[as]);
      assert.notEqual(res.status, 201);
      const forged = await call(handler, 'POST', '/api/items', { quest, actor: 'maker' }, who[as]);
      assert.notEqual(forged.status, 201);
    }
    assert.equal(store.listItems().length, 0);
    const spoof = { quest, actor: 'boss', role: 'leader', type: 'approved' };
    const made = await call(handler, 'POST', '/api/items', spoof, who.maker);
    assert.equal(made.status, 201);
    const [event, ...rest] = store.events(made.json.id);
    assert.equal(rest.length, 0);
    assert.equal(event.actor, 'maker');
    assert.equal(event.type, 'checked');
    const extras = ['role', 'helpers', 'approval', 'cap_usd', 'quorum'];
    assert.deepEqual(Object.keys(event).filter(k => extras.includes(k)), []);
    assert.equal(made.json.state.state, 'CHECKED');
    assert.equal(made.json.state.context.helpers.length, 0);
    // A quest cannot ride on any later step, so it cannot skip, approve, deliver or help.
    for (const type of ['specced', 'approved', 'helped', 'tried', 'shelved', 'commented', 'charged']) {
      const res = await call(handler, 'POST', `/api/items/${made.json.id}/events`, { type, quest }, who.boss);
      assert.notEqual(res.status, 201, type);
    }
    const art = await call(handler, 'POST', `/api/items/${made.json.id}/artifact`, { html: 'x', quest }, who.maker);
    assert.notEqual(art.status, 201);
    assert.equal(store.events(made.json.id).length, 1);
    // The author cannot count as a helper on their own item.
    const vote = { type: 'helped', artifact_hash: 'a'.repeat(64) };
    const help = await call(handler, 'POST', `/api/items/${made.json.id}/events`, vote, who.maker);
    assert.notEqual(help.status, 201);
  } finally { store.close(); }
});

test('authority: falsy or odd quest values fall back to the hand path and never to a bypass', async () => {
  const { store, handler, who } = await world(['maker', false]);
  try {
    for (const quest of [[], 'x', 7, true, {}, { version: 1 }]) {
      const res = await call(handler, 'POST', '/api/items', { quest }, who.maker);
      assert.ok(res.status >= 400 && res.status < 500, JSON.stringify(quest));
    }
    assert.equal(store.listItems().length, 0);
  } finally { store.close(); }
});

test('limits: oversized or malformed quests are refused with no write', async () => {
  const { store, handler, who } = await world(['maker', false]);
  try {
    const good = completedQuest({}, 'maker');
    const edit = fn => { const doc = structuredClone(good); fn(doc); return doc; };
    const huge = edit(d => { for (let i = 0; i < 70; i += 1) d.turns.push({ step: 'occurrence', value: 'x'.repeat(1900), note: '' }); });
    const cases = {
      longValue: edit(d => { d.turns[0].value = 'x'.repeat(2001); }),
      longNote: edit(d => { d.turns[6].note = 'x'.repeat(2001); }),
      nulByte: edit(d => { d.turns[0].value = 'a\u0000b'; }),
      blank: edit(d => { d.turns[0].value = '   '; }),
      extraTurnKey: edit(d => { d.turns[0].evil = 1; }),
      extraDocKey: edit(d => { d.role = 'leader'; }),
      nonString: edit(d => { d.turns[0].value = { a: 1 }; }),
      unknownStep: edit(d => { d.turns[0].step = 'approve'; }),
      badOption: edit(d => { d.turns[6].value = 'maybe'; }),
      tooManyTurns: edit(d => { d.turns.push(...Array.from({ length: 121 }, () => ({ step: 'priority', value: 'again', note: '' }))); }),
      tooManyBytes: huge,
      wideBytes: edit(d => {
        for (const t of d.turns) {
          t.note = '\u20ac'.repeat(2000);
          if (!STEPS.find(x => x.key === t.step).options) t.value = t.note;
        }
      }),
      pendingBad: edit(d => { d.pending = { step: 'problem', value: 'x'.repeat(2001), note: '' }; }),
    };
    for (const [name, quest] of Object.entries(cases)) {
      const res = await call(handler, 'POST', '/api/items', { quest }, who.maker);
      assert.ok(res.status >= 400 && res.status < 500, `${name}: ${res.status}`);
    }
    const padded = JSON.stringify({ quest: good, pad: 'x'.repeat(400 * 1024) });
    const bodyTooBig = await call(handler, 'POST', '/api/items', {}, who.maker, padded);
    assert.ok(bodyTooBig.status >= 400 && bodyTooBig.status < 500);
    const proto = await call(handler, 'POST', '/api/items', undefined, who.maker, '{"quest":{"__proto__":{"person":"maker"}}}');
    assert.ok(proto.status >= 400 && proto.status < 500);
    assert.equal(store.listItems().length, 0);
  } finally { store.close(); }
});

test('limits: the largest legal quest posts, and every text field has the same bound', async () => {
  const { store, handler, who } = await world(['maker', false]);
  try {
    const overrides = Object.fromEntries(STEPS.filter(s => !s.options).map(s => [s.key, 'y'.repeat(2000)]));
    const quest = completedQuest(overrides, 'maker');
    for (const turn of quest.turns) if (STEPS.find(s => s.key === turn.step).options) turn.note = 'n'.repeat(2000);
    const res = await call(handler, 'POST', '/api/items', { quest }, who.maker);
    assert.equal(res.status, 201);
    for (const step of STEPS.filter(s => !s.options)) {
      assert.throws(() => answerQuest(emptyQuest('maker'), step.key, 'z'.repeat(2001)), Error, step.key);
    }
  } finally { store.close(); }
});

test('drafts: a half-finished draft survives a restart and is private to its author', async () => {
  const disk = storage();
  let doc = emptyQuest('maker');
  doc = answerQuest(doc, 'occurrence', 'Last Tuesday the field rejected a valid entry.');
  let saved = await saveDraft(disk, doc, null, lock);
  doc = answerQuest(saved.doc, 'problem', 'The form refuses a normal value.');
  saved = await saveDraft(disk, doc, saved.head, lock);
  // A restart: nothing in memory, only the stored bytes.
  const afterRestart = storage();
  for (const [k, v] of disk.values) afterRestart.values.set(k, v);
  const resumed = await loadDraft(afterRestart, 'maker');
  assert.equal(resumed.doc.turns.length, 2);
  // Another person on the same browser sees nothing and cannot open, resume or restore the file.
  const other = await loadDraft(afterRestart, 'intruder');
  assert.equal(other.doc.turns.length, 0);
  assert.equal(other.head, null);
  const stolen = disk.getItem(`sss-quest:maker:${resumed.head}`);
  await assert.rejects(openQuest(stolen, 'intruder'), /Invalid quest draft/);
  await assert.rejects(restoreDraft(afterRestart, stolen, 'intruder', null, lock), /Invalid quest draft/);
  assert.equal([...afterRestart.values.keys()].filter(k => k.includes('intruder')).length, 0);
  // Keys that merely look like another person's prefix do not collide.
  await saveDraft(afterRestart, answerQuest(emptyQuest('maker:x'), 'occurrence', 'Different person'), null, lock);
  assert.equal((await loadDraft(afterRestart, 'maker')).doc.turns.length, 2);
});

test('no model and no network: the session code makes no outbound request', async () => {
  const files = ['public/vision-quest.js', 'public/quest-storage.js', 'app/pages.js'];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const outbound = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|node:(net|http|https|dns|tls|dgram)|https?:\/\//;
    assert.doesNotMatch(source, outbound, file);
  }
  const ui = readFileSync(new URL('../public/quest-ui.js', import.meta.url), 'utf8');
  const targets = [...ui.matchAll(/fetch\(\s*([^,)]+)/g)].map(match => match[1].trim());
  assert.deepEqual(targets.sort(), ["'/api/items'", "'/api/me'"]);
  assert.doesNotMatch(ui, /XMLHttpRequest|WebSocket|EventSource|sendBeacon|https?:\/\//);
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;
  let attempts = 0;
  globalThis.fetch = () => { attempts += 1; throw Error('network used'); };
  net.Socket.prototype.connect = function () { attempts += 1; throw Error('network used'); };
  try {
    const doc = completedQuest({ setting: 'works' });
    deriveQuest(doc);
    checkedFromQuest(doc, 'maker');
    const disk = storage();
    const saved = await saveDraft(disk, doc, null, lock);
    await openQuest(disk.getItem(`sss-quest:maker:${saved.head}`), 'maker');
    assert.equal(attempts, 0);
  } finally {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
  }
});

test('output: the item page shows a quest memo with every typed field escaped', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&</details><script>1</script>';
  const quest = completedQuest(Object.fromEntries(STEPS.filter(s => !s.options).map(s => [s.key, evil])));
  const draft = deriveQuest(quest);
  const html = itemPage(item(), [{ type: 'checked', actor: 'maker', ...checkedFromQuest(quest, 'maker') }], 'maker', true);
  assert.equal(draft.recommendation, 'BUILD');
  assert.doesNotMatch(html, /<img|<script(?! src=)|onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<textarea name="must" required>&lt;img/);
});

test('draft spec: a build proposal prefills the steward spec form and nothing else', () => {
  const quest = completedQuest({ first_test: 'Try one rough change', better: 'Fewer reopened tickets', out_scope: 'Reporting' });
  const events = [{ type: 'checked', actor: 'maker', ...checkedFromQuest(quest, 'maker') }];
  const mine = itemPage(item(), events, 'maker', false);
  assert.match(mine, /name="must" required>Try one rough change<\/textarea>/);
  assert.match(mine, /name="how_we_know" required>Fewer reopened tickets<\/textarea>/);
  assert.match(mine, /name="out_of_scope">Reporting<\/textarea>/);
  assert.doesNotMatch(itemPage(item(), events, 'boss', true), /<form data-event="specced">/);
  const byHand = { type: 'checked', actor: 'maker', problem: 'p', looked: ['x'], found: [], verdict: 'build_needed' };
  const plain = itemPage(item(), [byHand], 'maker', false);
  assert.match(plain, /name="must" required><\/textarea>/);
});

test('process change posts as the existing setting verdict, kill stays a memo', async () => {
  const process = completedQuest({ approach: 'process' }, 'maker');
  assert.equal(deriveQuest(process).recommendation, 'PROCESS CHANGE');
  assert.equal(checkedFromQuest(process, 'maker').verdict, 'setting');
  const empty = completedQuest({ approach: 'process', have: 'unchecked', pay_for: 'unchecked', free: 'unchecked', setting: 'unchecked' });
  assert.throws(() => checkedFromQuest(empty, 'maker'), /cannot be posted/);
  assert.throws(() => checkedFromQuest(completedQuest({ approach: 'stop' }), 'maker'), /cannot be posted/);
  const { store, handler, who } = await world(['maker', false]);
  try {
    const made = await call(handler, 'POST', '/api/items', { quest: process }, who.maker);
    assert.equal(made.status, 201);
    assert.equal(made.json.state.state, 'CHECKED');
    const page = await call(handler, 'GET', `/items/${made.json.id}`, undefined, who.maker);
    assert.match(page.text, /PROCESS CHANGE/);
    assert.doesNotMatch(page.text, /data-event="specced"/);
  } finally { store.close(); }
});
