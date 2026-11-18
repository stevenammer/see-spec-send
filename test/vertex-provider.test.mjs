import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceAccountTokens, vertexHost, vertexUrl } from '../provider/vertex.js';
import { vertex } from '../provider/adapters.js';
import { validateProvider } from '../provider/config.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
function keyFile(mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'sss-vertex-')); const file = join(dir, 'sa.json');
  writeFileSync(file, JSON.stringify({ type: 'service_account', client_email: 'sss@example.com', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' }));
  chmodSync(file, mode); return file;
}
async function stand({ tokenStatus = 200 } = {}) {
  const seen = { tokens: 0, assertions: [], chats: [] };
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/token') {
        seen.tokens += 1; seen.assertions.push(new URLSearchParams(body).get('assertion'));
        res.writeHead(tokenStatus, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(tokenStatus === 200 ? { access_token: `tok${seen.tokens}`, expires_in: 3600 } : { error: 'bad' }));
      }
      seen.chats.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'hello from vertex' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` };
}

test('the sign-in is a signed JWT with the right claims, and the token is reused until it is nearly out', async t => {
  const { server, seen, base } = await stand(); t.after(() => server.close());
  let now = 1_800_000_000_000;
  const token = serviceAccountTokens({ keyFile: keyFile(), tokenUri: `${base}/token`, allowPrivate: true, clock: () => now });
  assert.equal(await token(), 'tok1'); assert.equal(await token(), 'tok1'); assert.equal(seen.tokens, 1, 'two calls, one sign-in');
  const [head, claim, sig] = seen.assertions[0].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(claim, 'base64url'));
  assert.equal(claims.iss, 'sss@example.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
  assert.equal(claims.aud, `${base}/token`); assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(createVerify('RSA-SHA256').update(`${head}.${claim}`).verify(publicKey, Buffer.from(sig, 'base64url')), 'signed with the service account key');
  now += 3_600_000;
  assert.equal(await token(), 'tok2', 'a new token once the old one has run out'); assert.equal(seen.tokens, 2);
});

test('the Vertex adapter sends the bearer token and the model, and returns text and usage', async t => {
  const { server, seen, base } = await stand(); t.after(() => server.close());
  const tokens = serviceAccountTokens({ keyFile: keyFile(), tokenUri: `${base}/token`, allowPrivate: true });
  const provider = vertex({ project: 'example-project', location: 'us-central1', url: `${base}/chat`, hosts: ['127.0.0.1'], allowPrivate: true, tokens });
  const out = await provider.complete({ model: 'google/gemini-2.5-flash', system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 20 });
  assert.deepEqual(out, { text: 'hello from vertex', usage: { inputTokens: 7, outputTokens: 3 } });
  assert.equal(seen.chats[0].auth, 'Bearer tok1'); assert.equal(seen.chats[0].body.model, 'google/gemini-2.5-flash');
  const chat = await provider.chat({ model: 'google/gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, stream: false });
  assert.equal(chat.choices[0].message.content, 'hello from vertex'); assert.equal(seen.tokens, 1, 'chat reused the token');
});

test('a key file other people can read is refused, and a refused sign-in never shows the key', async t => {
  assert.throws(() => serviceAccountTokens({ keyFile: keyFile(0o644) }), /readable by others/);
  assert.throws(() => serviceAccountTokens({ keyFile: 'relative.json' }), /absolute/);
  const { server, base } = await stand({ tokenStatus: 401 }); t.after(() => server.close());
  const token = serviceAccountTokens({ keyFile: keyFile(), tokenUri: `${base}/token`, allowPrivate: true });
  await assert.rejects(token, error => { assert.match(error.message, /sign-in refused \(HTTP 401\)/); assert.ok(!error.message.includes('PRIVATE KEY')); return true; });
});

test('a Vertex provider is configured with a project, a location and a service account file, never a key', () => {
  const good = { name: 'vertex', kind: 'vertex', enabled: true, project: 'example-project', location: 'us-central1', model: 'google/gemini-2.5-flash', serviceAccountFile: '/etc/sss/sa.json', price: { inputMicrosPerMillion: 300000, outputMicrosPerMillion: 2500000 } };
  assert.doesNotThrow(() => validateProvider(good));
  for (const bad of [{ ...good, apiKey: 'x' }, { ...good, private_key: 'x' }, { ...good, project: 'Bad Project' }, { ...good, location: 'moon' }, { ...good, serviceAccountFile: 'sa.json' }, { ...good, price: undefined }])
    assert.throws(() => validateProvider(bad), /Vertex|priced|invalid/);
  assert.equal(vertexUrl({ project: 'p-12345', location: 'us-central1' }), 'https://us-central1-aiplatform.googleapis.com/v1/projects/p-12345/locations/us-central1/endpoints/openapi/chat/completions');
  assert.equal(vertexHost({ location: 'global' }), 'aiplatform.googleapis.com');
});
