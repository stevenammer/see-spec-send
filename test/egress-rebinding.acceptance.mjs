// Root-run proof, not part of npm test: it starts a loopback listener.
// Run with: node --test test/egress-rebinding.acceptance.mjs
// A toy resolver answers loopback first and the cloud metadata address on every later call.
// Pinning means the second answer is never asked for and never dialed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { jsonRequest } from '../provider/safe-http.js';

const completion = JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

test('a DNS rebinding flip after the check is never dialed', async t => {
  let served = 0;
  const server = createServer((req, res) => { served += 1; res.setHeader('content-type', 'application/json'); res.end(completion); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://rebind.test:${server.address().port}/v1/chat`;
  let lookups = 0;
  const resolver = async () => { lookups += 1; return lookups === 1 ? [{ address: '127.0.0.1' }] : [{ address: '169.254.169.254' }]; };
  const body = await jsonRequest(url, { hosts: ['rebind.test'], allowPrivate: true, body: {}, resolver });
  assert.equal(body.choices[0].message.content, 'ok');
  assert.equal(lookups, 1, 'the host is resolved once');
  assert.equal(served, 1, 'the one checked address is the one dialed');
});

test('without allowPrivate, a loopback answer is refused before any connection', async t => {
  let served = 0;
  const server = createServer((req, res) => { served += 1; res.end(completion); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `https://rebind.test:${server.address().port}/v1/chat`;
  await assert.rejects(() => jsonRequest(url, { hosts: ['rebind.test'], body: {}, resolver: async () => [{ address: '127.0.0.1' }] }), /private provider address refused/);
  assert.equal(served, 0);
});
