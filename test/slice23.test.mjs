import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { Integrations } from '../app/integrations.js';
import { redact } from '../provider/safe-http.js';
import { main as cli } from '../cli.js';

const password = 'correct-horse-9-battery';
const ORIGIN = 'http://127.0.0.1';
const WRONG_CANARY = 'Canary-Wrong-Pass-7f3a9c';
const PROBLEM_CANARY = 'CANARY-PROBLEM-99';
const BEARER_CANARY = 'CANARY-BEARER-55';
const BASIC_CANARY = 'Q0FOQVJZLUJBU0lDLTU1';
const SECRET = 'slice23-integration-secret-value';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class Response {
  constructor() { this.headers = {}; this.status = 200; this.text = ''; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) {
    this.status = status;
    for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value;
  }
  end(value = '') { this.text += value; }
}

async function call(handler, method, path, input, headers = {}) {
  const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]);
  req.method = method;
  req.url = path;
  req.headers = { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new Response();
  await handler(req, res);
  let body;
  try { body = JSON.parse(res.text); } catch { body = undefined; }
  return { status: res.status, headers: res.headers, body, text: res.text };
}

function fixture(options = {}) {
  const lines = [];
  const store = new Store();
  const auth = new Auth(store);
  const handler = createHandler({ store, auth, secure: false, origin: ORIGIN, log: line => lines.push(line), ...options });
  return { store, auth, handler, lines };
}

async function signIn(handler, id, secret = password) {
  const response = await call(handler, 'POST', '/api/login', { id, password: secret }, { origin: ORIGIN });
  const cookie = response.headers['set-cookie'].split(';')[0];
  return { status: response.status, cookie, csrf: response.body?.csrf, headers: { cookie, origin: ORIGIN, 'x-csrf-token': response.body?.csrf } };
}

test('every request writes one JSON line with request ID, route pattern, status, person, and duration', async () => {
  const { store, auth, handler, lines } = fixture();
  await auth.createUser('lead', password, true);
  const session = await signIn(handler, 'lead');
  const created = await call(handler, 'POST', '/api/items', { problem: 'Queue backs up at noon', have: true, have_note: 'looked', verdict: 'build_needed' }, session.headers);
  assert.equal(created.status, 201);
  const listing = await call(handler, 'GET', '/api/items', undefined, session.headers);
  assert.equal(listing.status, 200);
  const read = await call(handler, 'GET', `/api/items/${created.body.id}`, undefined, session.headers);
  assert.equal(read.status, 200);
  const requests = lines.map(line => JSON.parse(line)).filter(entry => entry.event === 'request');
  assert.equal(requests.length, 4, `expected one line per request, got ${lines.length} lines`);
  for (const entry of requests) {
    assert.match(entry.rid, UUID);
    assert.equal(typeof entry.ms, 'number');
    assert.ok(entry.ms >= 0);
  }
  const byRoute = Object.fromEntries(requests.map(entry => [`${entry.route} ${entry.status}`, entry]));
  assert.equal(byRoute['/api/login 200'].person, null);
  assert.equal(byRoute['/api/items 201'].person, 'lead');
  assert.equal(byRoute['/api/items 200'].person, 'lead');
  assert.equal(byRoute['/api/items/:id 200'].person, 'lead');
  assert.equal(byRoute['/api/items/:id 200'].rid, read.headers['x-request-id']);
  assert.equal(created.headers['x-request-id'], byRoute['/api/items 201'].rid);
  assert.equal(store.listItems().length, 1);
});

test('sign-in outcomes are logged as ok or refused, never with a password', async () => {
  const { auth, handler, lines } = fixture();
  await auth.createUser('lead', password, true);
  await signIn(handler, 'lead');
  // Read after the good sign-in: one failure starts a short per-address backoff.
  const failed = await call(handler, 'POST', '/api/login', { id: 'lead', password: WRONG_CANARY }, { origin: ORIGIN });
  assert.equal(failed.status, 400);
  const signins = lines.map(line => JSON.parse(line)).filter(entry => entry.event === 'sign_in');
  assert.deepEqual(signins.map(entry => entry.outcome), ['ok', 'refused']);
  assert.equal(signins[0].person, 'lead');
  assert.equal(signins[1].person, undefined);
  assert.equal(lines.join('\n').includes(WRONG_CANARY), false);
});

test('planted canaries never reach the request log', async () => {
  const { auth, handler, lines } = fixture();
  await auth.createUser('lead', password, true);
  const session = await signIn(handler, 'lead');
  await call(handler, 'POST', '/api/login', { id: 'lead', password: WRONG_CANARY }, { origin: ORIGIN });
  await call(handler, 'POST', '/api/items', { problem: PROBLEM_CANARY, have: true, have_note: 'looked', verdict: 'build_needed' },
    { ...session.headers, authorization: `Bearer ${BEARER_CANARY}` });
  await call(handler, 'GET', '/api/items', undefined, { ...session.headers, authorization: `Basic ${BASIC_CANARY}` });
  const canaries = [password, WRONG_CANARY, PROBLEM_CANARY, BEARER_CANARY, BASIC_CANARY, session.csrf,
    session.cookie.split('=')[1]];
  // A vacuous scan of zero lines would pass, so the scan must see one line per request first.
  assert.equal(lines.filter(line => JSON.parse(line).event === 'request').length, 4);
  const everything = lines.join('\n');
  for (const canary of canaries) assert.equal(everything.includes(canary), false, 'a planted canary reached the log');
});

test('an unexpected error returns 500 with the request ID and logs the stack', async () => {
  const integrations = { receive() { throw new TypeError('synthetic defect in receive'); } };
  const { handler, lines } = fixture({ integrations });
  const response = await call(handler, 'POST', '/api/integrations/inbound/slack', { problem: 'x' },
    { 'x-sss-timestamp': '1', 'x-sss-signature': 'sha256=x', 'idempotency-key': 'k' });
  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'server error');
  assert.equal(response.body.request_id, response.headers['x-request-id']);
  assert.match(response.body.request_id, UUID);
  const entries = lines.map(line => JSON.parse(line));
  const failure = entries.find(entry => entry.event === 'error');
  assert.ok(failure, 'expected an error line');
  assert.equal(failure.rid, response.body.request_id);
  assert.match(failure.stack, /TypeError: synthetic defect in receive/);
  assert.equal(entries.find(entry => entry.event === 'request').status, 500);
});

test('admin commands append to the audit table and verify checks its chain', async t => {
  t.after(() => { process.exitCode = 0; });
  const directory = mkdtempSync(join(tmpdir(), 'sss-s23-audit-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite'); const env = { SSS_DB: file }; const lines = [];
  const write = value => lines.push(value);
  await cli(['init', '--id', 'leader'], env, write);
  await cli(['invite', 'create', '--role', 'member'], env, write);
  await cli(['person', 'disable', '--id', 'leader'], env, write).catch(() => {});
  const reader = new DatabaseSync(file, { readOnly: true });
  const rows = reader.prepare('SELECT command, outcome FROM admin_audit ORDER BY seq').all();
  reader.close();
  assert.ok(rows.some(row => row.command === 'init' && row.outcome === 'ok'), JSON.stringify(rows));
  assert.ok(rows.some(row => row.command === 'invite create' && row.outcome === 'ok'), JSON.stringify(rows));
  assert.ok(rows.some(row => row.command === 'person disable' && row.outcome === 'failed'), JSON.stringify(rows));
  lines.length = 0;
  await cli(['verify'], env, write);
  assert.ok(lines.includes('audit: ok'), lines.join('\n'));
  const writer = new DatabaseSync(file);
  writer.exec("UPDATE admin_audit SET outcome='ok' WHERE seq=(SELECT min(seq) FROM admin_audit WHERE outcome<>'ok')");
  writer.exec("UPDATE admin_audit SET command='invite revoke' WHERE command='invite create'");
  writer.close();
  lines.length = 0;
  await cli(['verify'], env, write);
  assert.equal(process.exitCode, 1);
  assert.ok(lines.some(line => line.startsWith('audit: ') && line !== 'audit: ok'), lines.join('\n'));
});

test('integration secrets are never accepted as a literal on the command line', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sss-s23-secret-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite'); const env = { SSS_DB: file }; const lines = [];
  const refused = await cli(['integration', 'source', 'add', '--name', 'literal', '--secret', SECRET], env, value => lines.push(value));
  assert.equal(refused, 2, 'a literal --secret must exit with the refusal code');
  assert.equal(lines.join('\n').includes(SECRET), false);
  assert.equal(existsSync(file) ? new Integrations(new Store(file)).list('source').length : 0, 0);
  const reader = existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
  if (reader) {
    const audit = reader.prepare('SELECT detail FROM admin_audit').all().map(row => row.detail).join('\n');
    reader.close();
    assert.equal(audit.includes(SECRET), false, 'the audit must never record a secret');
  }

  await cli(['integration', 'source', 'add', '--name', 'fromenv', '--secret-env', 'SLICE23_SECRET'],
    { ...env, SLICE23_SECRET: SECRET }, value => lines.push(value));
  const secretFile = join(directory, 'hook.secret'); writeFileSync(secretFile, `${SECRET}-file\n`, { mode: 0o600 });
  await cli(['integration', 'destination', 'add', '--name', 'fromfile', '--url', 'https://example.com/hook', '--secret-file', secretFile], env, value => lines.push(value));
  const stored = new Store(file);
  const reading = new Integrations(stored);
  assert.deepEqual(reading.list('source').map(row => row.name), ['fromenv']);
  assert.deepEqual(reading.list('destination').map(row => row.name), ['fromfile']);
  const raw = new DatabaseSync(file, { readOnly: true }).prepare('SELECT secret FROM integration_destinations').get().secret;
  // Slice 24: stored sealed, never as plaintext. The value is recoverable only with the key file.
  assert.equal(raw.includes(SECRET), false);
  assert.equal(reading.unpack(raw).current, `${SECRET}-file`);
  stored.close();

  const piped = spawnSync(process.execPath, [new URL('../cli.js', import.meta.url).pathname, 'integration', 'source', 'add', '--name', 'stdinsrc', '--secret-stdin'],
    { input: `${SECRET}-stdin\n`, env: { ...process.env, SSS_DB: file }, encoding: 'utf8' });
  assert.equal(piped.status, 0, piped.stderr);
  const literal = spawnSync(process.execPath, [new URL('../cli.js', import.meta.url).pathname, 'integration', 'source', 'add', '--name', 'argv', '--secret', SECRET],
    { env: { ...process.env, SSS_DB: file }, encoding: 'utf8' });
  assert.equal(literal.status, 2);
  assert.equal((literal.stdout + literal.stderr).includes(SECRET), false);
});

test('redaction covers Bearer, Basic, and JSON shapes as well as key-value pairs', () => {
  assert.equal(redact('authorization: Bearer sk-live-abc123').includes('sk-live-abc123'), false);
  assert.equal(redact('upstream said Bearer sk-live-xyz789 in its reply').includes('sk-live-xyz789'), false);
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNz').includes('dXNlcjpwYXNz'), false);
  const json = redact('{"password":"hunter2-long","token":"tok-123","secret": "s3cret-value"}');
  for (const leaked of ['hunter2-long', 'tok-123', 's3cret-value']) assert.equal(json.includes(leaked), false, json);
  assert.match(redact('secret=abc123'), /\[redacted\]/);
  assert.equal(redact('no secrets here'), 'no secrets here');
});
