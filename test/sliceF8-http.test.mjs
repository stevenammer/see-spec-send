import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';

class Response {
 constructor() { this.headers = {}; this.status = 200; this.text = ''; }
 setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
 writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }
 end(text = '') { this.text += text; }
}
async function call(handler, method, path, input = null, headers = {}) {
 const req = Readable.from(input === null ? [] : [JSON.stringify(input)]);
 req.method = method; req.url = path; req.headers = { ...(input === null ? {} : { 'content-type': 'application/json' }), ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
 const res = new Response(); await handler(req, res);
 return { status: res.status, text: res.text, headers: res.headers, body: res.headers['content-type']?.includes('application/json') ? JSON.parse(res.text) : null };
}
test('F8 analysis HTTP rechecks session access, CSRF, exact snapshot and citation membership without a vendor call', async t => {
 const store = new Store(); t.after(() => store.close()); const auth = new Auth(store), password = 'fixture-analysis-password-9';
 await auth.createUser('op', password, false);
 const handler = createHandler({ store, auth, secure: false, origin: 'http://localhost' });
 const login = await call(handler, 'POST', '/api/login', { id: 'op', password });
 const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost', 'x-csrf-token': login.body.csrf };
 const at = '2026-11-14T00:00:00.000Z';
 store.append('a', { type: 'posted', actor: 'op', original: 'A synthetic handoff issue.', rules: 2, at }, { idem: 'post' });
 const request = { question: 'What should we investigate about handoffs?', objectives: ['Preserve caller context.'], constraints: ['No private employee data.'], items: ['a'], from: at, to: '2026-11-14T23:00:00.000Z' };
 assert.equal((await call(handler, 'GET', '/intelligence')).status, 403);
 assert.equal((await call(handler, 'POST', '/api/intelligence/package', request)).status, 403);
 assert.equal((await call(handler, 'POST', '/api/intelligence/package', request, { cookie: headers.cookie, origin: headers.origin })).status, 403);
 const page = await call(handler, 'GET', '/intelligence', null, headers); assert.equal(page.status, 200); assert.match(page.text, /makes no model call/);
 const result = await call(handler, 'POST', '/api/intelligence/package', request, headers); assert.equal(result.status, 200);
 const packet = result.body, review = { request, package_hash: packet.hash, answer: JSON.stringify(packet.answer_contract) };
 assert.equal((await call(handler, 'POST', '/api/intelligence/review', review, headers)).status, 200);
 const forged = structuredClone(packet.answer_contract); forged.findings[0].citations[0].hash = 'f'.repeat(64);
 assert.equal((await call(handler, 'POST', '/api/intelligence/review', { ...review, answer: JSON.stringify(forged) }, headers)).status, 409);
 store.append('a', { type: 'revised', actor: 'op', text: 'A clarified issue, leaving the original intact.', base_hash: store.read('a').context.seeHash, at }, { idem: 'revise' });
 assert.equal((await call(handler, 'POST', '/api/intelligence/review', review, headers)).status, 409);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM gateway_effort_receipts').get().n, 0);
 store.db.prepare("INSERT INTO person_state VALUES('op',1)").run();
 assert.equal((await call(handler, 'POST', '/api/intelligence/package', request, headers)).status, 403);
});
