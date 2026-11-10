import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { itemPage } from '../app/pages.js';

const password = 'correct-horse-9-battery';
const hash = 'a'.repeat(64);

function trying(helpers = []) {
  return {
    id: 'item1',
    state: 'TRYING',
    context: { steward: 'maya', approver: 'lead', helpers, quorum: 2, artifact: hash },
  };
}
const events = [
  { type: 'checked', problem: 'A problem', actor: 'maya' },
  { type: 'tried', actor: 'f'.repeat(64), delivered_by: 'maya', artifact_hash: hash },
];

test('the history names the person who delivered the try, never a token hash', () => {
  const page = itemPage(trying(), events, 'ben', false);
  assert.match(page, /maya delivered a try/);
  assert.doesNotMatch(page, new RegExp('f'.repeat(64)));
});

test('everyone can see the try, but only people who may vote get the button', () => {
  const asSteward = itemPage(trying(), events, 'maya', false);
  const asApprover = itemPage(trying(), events, 'lead', true);
  const asMember = itemPage(trying(), events, 'ben', false);
  for (const page of [asSteward, asApprover, asMember])
    assert.match(page, /<iframe[^>]+sandbox="allow-scripts"/);
  assert.doesNotMatch(asSteward, /data-event="helped"/);
  assert.doesNotMatch(asApprover, /data-event="helped"/);
  assert.match(asMember, /data-event="helped"/);
});

test('the sandbox never allows same-origin access', () => {
  assert.doesNotMatch(itemPage(trying(), events, 'ben', false), /allow-same-origin/);
});

function setup() {
  const store = new Store();
  const auth = new Auth(store);
  return { store, auth, handler: createHandler({ store, auth }) };
}

async function call(handler, method, path, input, headers = {}) {
  const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]);
  req.method = method;
  req.url = path;
  req.headers = {
    ...(input === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = {
    headers: {},
    status: 200,
    text: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(value = '') {
      this.text += value;
    },
  };
  await handler(req, res);
  return {
    ...res,
    body: res.headers['content-type']?.includes('json') && res.text ? JSON.parse(res.text) : {},
  };
}

test('delivering outside the Send stage stores nothing', async () => {
  const { store, auth, handler } = setup();
  await auth.createUser('maya', password, false);
  const login = await call(handler, 'POST', '/api/login', { id: 'maya', password });
  const headers = {
    cookie: login.headers['set-cookie'].split(';')[0],
    origin: 'https://localhost',
    'x-csrf-token': login.body.csrf,
  };
  const made = await call(
    handler,
    'POST',
    '/api/items',
    {
      problem: 'A problem',
      have: true,
      have_note: 'looked',
      verdict: 'build_needed',
    },
    headers,
  );
  const bodies = () => store.db.prepare('SELECT count(*) AS n FROM bodies').get().n;
  const before = bodies();
  const refused = await call(
    handler,
    'POST',
    `/api/items/${made.body.id}/artifact`,
    { html: '<h1>early</h1>' },
    headers,
  );
  assert.equal(refused.status, 409);
  assert.equal(bodies(), before, 'no artifact bytes may be stored before the Send stage');
});

// Shared setup: an item that a leader has approved, so it is waiting for a try.
async function itemInSend() {
  const { store, auth, handler } = setup();
  await auth.createUser('maya', password, false);
  await auth.createUser('lead', password, true);
  await auth.createUser('ben', password, false);
  await auth.createUser('cleo', password, false);
  const sign = async id => {
    const login = await call(handler, 'POST', '/api/login', { id, password });
    return {
      cookie: login.headers['set-cookie'].split(';')[0],
      origin: 'https://localhost',
      'x-csrf-token': login.body.csrf,
    };
  };
  const maya = await sign('maya');
  const lead = await sign('lead');
  const made = await call(
    handler,
    'POST',
    '/api/items',
    {
      problem: 'A problem',
      have: true,
      have_note: 'looked',
      verdict: 'build_needed',
    },
    maya,
  );
  const id = made.body.id;
  const events = `/api/items/${id}/events`;
  await call(
    handler,
    'POST',
    events,
    { type: 'specced', must: ['x'], how_we_know: ['y'], out_of_scope: [] },
    maya,
  );
  await call(handler, 'POST', '/api/stepup', { password }, lead);
  const approved = await call(
    handler,
    'POST',
    events,
    { type: 'approved', cap_usd: 1, quorum: 2 },
    lead,
  );
  assert.equal(approved.status, 201);
  return { store, handler, id, maya, lead, sign };
}

test('a try of exactly 256 KB is accepted and one byte more is refused', async () => {
  const { handler, id, maya } = await itemInSend();
  const path = `/api/items/${id}/artifact`;
  const tooBig = await call(handler, 'POST', path, { html: 'x'.repeat(256 * 1024 + 1) }, maya);
  assert.equal(tooBig.status, 409, 'one byte over the limit must be refused in the Send stage');
  const multibyte = await call(handler, 'POST', path, { html: '€'.repeat(100_000) }, maya);
  assert.equal(multibyte.status, 409, 'the limit counts bytes, not characters');
  const fits = await call(handler, 'POST', path, { html: 'x'.repeat(256 * 1024) }, maya);
  assert.equal(fits.status, 201, 'exactly 256 KB must be accepted');
});

test('the list never exposes who said it helps, only how many', async () => {
  const { store, handler, id, maya, sign } = await itemInSend();
  await call(handler, 'POST', `/api/items/${id}/artifact`, { html: '<h1>try</h1>' }, maya);
  const artifact = store.read(id).context.artifact;
  for (const person of ['ben', 'cleo']) {
    const headers = await sign(person);
    await call(
      handler,
      'POST',
      `/api/items/${id}/events`,
      { type: 'helped', artifact_hash: artifact },
      headers,
    );
  }
  const [entry] = store.listItems();
  assert.equal(entry.helpers, 2);
  for (const value of Object.values(entry))
    assert.notEqual(typeof value, 'object', 'only plain values');
  assert.doesNotMatch(JSON.stringify(entry), /ben|cleo/, 'no helper identity in the list');
  const page = await call(handler, 'GET', '/', undefined, await sign('maya'));
  assert.doesNotMatch(page.text, /ben|cleo/, 'the feed page shows no helper identity');
});
