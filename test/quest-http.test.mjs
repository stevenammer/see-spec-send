import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { itemPage, htmlHeaders } from '../app/pages.js';
import { completedQuest } from './helpers/quest-fixture.mjs';

async function call(handler, method, url, input, headers = {}) {
  const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]);
  req.method = method;
  req.url = url;
  req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = { headers: {}, text: '', setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, values = {}) { this.status = status; Object.assign(this.headers, values); },
    end(text = '') { this.text += text; } };
  await handler(req, res);
  return { ...res, json: res.headers['content-type']?.includes('json') && res.text ?
    JSON.parse(res.text) : null };
}

test('quest creation is explicit, signed-in, CSRF guarded and server-derived; memo exports without a raw transcript', async () => {
  const store = new Store();
  try {
    const auth = new Auth(store);
    const handler = createHandler({ store, auth });
    await auth.createUser('maker', 'synthetic-long-passphrase-7', false);
    const login = await call(handler, 'POST', '/api/login', {
      id: 'maker', password: 'synthetic-long-passphrase-7',
    });
    const headers = { cookie: login.headers['set-cookie'].split(';')[0],
      origin: 'https://localhost', 'x-csrf-token': login.json.csrf };
    assert.equal((await call(handler, 'GET', '/quest')).status, 403);
    const view = await call(handler, 'GET', '/quest', undefined, headers);
    assert.equal(view.status, 200);
    assert.equal(view.headers['content-security-policy'], htmlHeaders);
    assert.match(view.text, /One question at a time/);
    assert.equal(store.listItems().length, 0);
    const quest = completedQuest({ setting: 'works' });
    assert.equal((await call(handler, 'POST', '/api/items', { quest }, {})).status, 403);
    assert.equal((await call(handler, 'POST', '/api/items', { quest }, {
      ...headers, 'x-csrf-token': 'wrong',
    })).status, 403);
    const forged = await call(handler, 'POST', '/api/items', {
      quest: { ...quest, person: 'someone-else' },
    }, headers);
    assert.notEqual(forged.status, 201);
    assert.equal(store.listItems().length, 0);
    const made = await call(handler, 'POST', '/api/items', {
      quest, verdict: 'build_needed', problem: 'Ignore the transcript', memo: { verified: true },
    }, headers);
    assert.equal(made.status, 201);
    assert.equal(made.json.state.state, 'SEEN');
    const events = store.events(made.json.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].original, quest.turns.find(t => t.step === 'problem').value);
    assert.equal(events[0].quest, undefined);
    assert.equal(events[0].questMemo.recommendation, 'CONFIGURE');
    const rendered = await call(handler, 'GET', `/items/${made.json.id}`, undefined, headers);
    assert.match(rendered.text, /CONFIGURE/);
    assert.match(rendered.text, /data-event="specced"/);
    const restored = new Store();
    try {
      restored.importJsonl(store.exportJsonl());
      assert.deepEqual(restored.events(made.json.id)[0].questMemo, events[0].questMemo);
    } finally { restored.close(); }
    const bypass = await call(handler, 'POST', '/api/items/chosen/events', {
      type: 'checked', problem: 'Bypass', looked: ['checked'], found: [],
      verdict: 'build_needed', quest: {},
    }, headers);
    assert.equal(bypass.status, 409);
    const forgedMemo = await call(handler, 'POST', '/api/items/chosen/events', {
      type: 'checked', problem: 'Forged guide memo', looked: ['checked'], found: [],
      verdict: 'build_needed', questMemo: events[0].questMemo,
    }, headers);
    assert.equal(forgedMemo.status, 409);
    assert.equal(store.events('chosen').length, 0);
    const unsafe = await call(handler, 'POST', '/api/items', {
      quest: completedQuest({ occurrence: 'A harassment report' }),
    }, headers);
    assert.notEqual(unsafe.status, 201);
    assert.equal(store.listItems().length, 1);
  } finally { store.close(); }
});

test('legacy or imported malformed quest metadata cannot crash item rendering', () => {
  const item = { id: 'test', state: 'CHECKED', context: {
    steward: 'maker', helpers: [], quorum: 2,
  } };
  for (const quest of [{}, null, { version: 7 }, 'not a quest']) {
    const html = itemPage(item, [{ type: 'checked', actor: 'maker',
      problem: '<script>not markup</script>', quest }], 'maker', false);
    assert.match(html, /&lt;script&gt;not markup/);
  }
});


test('quest retries are canonical, simultaneous and durable, and cannot borrow another owner', async () => {
  const store = new Store();
  try {
    const auth = new Auth(store);
    let handler = createHandler({ store, auth });
    const headers = {};
    for (const person of ['maker', 'other']) {
      await auth.createUser(person, 'synthetic-long-passphrase-7', false);
      const login = await call(handler, 'POST', '/api/login', { id: person, password: 'synthetic-long-passphrase-7' });
      headers[person] = { cookie: login.headers['set-cookie'].split(';')[0],
        origin: 'https://localhost', 'x-csrf-token': login.json.csrf };
    }
    const quest = completedQuest({ chair: 'RAW PRIVATE CHAIR', depends: 'RAW PRIVATE DEPENDENCY' });
    const reversed = value => Array.isArray(value) ? value.map(reversed) :
      value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(k => [k, reversed(value[k])])) : value;
    const results = await Promise.all([quest, reversed(quest), quest].map(quest =>
      call(handler, 'POST', '/api/items', { quest }, headers.maker)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 201]);
    assert.equal(new Set(results.map(r => r.json.id)).size, 1);
    const id = results[0].json.id;
    assert.equal(store.events(id).length, 1);
    assert.equal(store.listItems().length, 1);
    assert.doesNotMatch(store.exportJsonl(), /RAW PRIVATE CHAIR|RAW PRIVATE DEPENDENCY|"turns"/);
    const detail = await call(handler, 'GET', `/api/items/${id}`, undefined, headers.other);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.events[0].quest, undefined);
    assert.equal(detail.json.events[0].questMemo.recommendation, 'BUILD');
    assert.doesNotMatch(detail.text, /RAW PRIVATE CHAIR|RAW PRIVATE DEPENDENCY|"turns"/);
    const stolen = await call(handler, 'POST', '/api/items', { quest }, headers.other);
    assert.ok(stolen.status >= 400 && stolen.status < 500);
    assert.equal(store.listItems().length, 1);
    const mine = await call(handler, 'POST', '/api/items', { quest: { ...quest, person: 'other' } }, headers.other);
    assert.equal(mine.status, 201);
    assert.notEqual(mine.json.id, id);
    // A fresh handler, and an export/import into a fresh store, retain the retry receipt.
    handler = createHandler({ store, auth });
    assert.equal((await call(handler, 'POST', '/api/items', { quest: reversed(quest) }, headers.maker)).json.id, id);
    const restored = new Store();
    try {
      restored.importJsonl(store.exportJsonl());
      // Imported event owner remains sufficient; authentication stays in the original auth DB.
      const retry = await call(createHandler({ store: restored, auth }), 'POST', '/api/items', { quest }, headers.maker);
      assert.equal(retry.status, 200);
      assert.equal(retry.json.id, id);
      assert.equal(restored.events(id).length, 1);
    } finally { restored.close(); }
  } finally { store.close(); }
});

test('memo metadata from old or damaged imports never crashes rendering', () => {
  const item = { id: 'test', state: 'CHECKED', context: { steward: 'maker', helpers: [], quorum: 2 } };
  for (const questMemo of [{}, null, 'bad', { recommendation: 'BUILD', reason: 'x', memo: {}, spec: {} },
    { recommendation: 'BUILD', reason: 'x', memo: { decisionOwner: 'x', stopCondition: 'x' },
      spec: { must: [null], how_we_know: [], out_of_scope: [] } }]) {
    assert.doesNotThrow(() => itemPage(item, [{ type: 'checked', actor: 'maker', problem: 'p', questMemo }], 'maker', false));
  }
});
