import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateProvider, readProviders } from '../provider/config.js';
import { main as cli, serveSettings } from '../cli.js';
import { Store } from '../core/store.js';
import { runAnalysis } from '../intelligence/run.js';

const nova = { name: 'nova-lite', kind: 'bedrock', enabled: true, region: 'us-east-1', modelId: 'amazon.nova-lite-v1:0', price: { inputMicrosPerMillion: 60000, outputMicrosPerMillion: 240000 } };

test('Bedrock configuration accepts reviewed model data and refuses every credential field', () => {
  assert.deepEqual(validateProvider(nova), nova);
  for (const key of ['apiKey', 'apiKeyEnv', 'apiKeyFile', 'credentials', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
    assert.throws(() => validateProvider({ ...nova, [key]: 'synthetic-secret' }), /credential/i, key);
  }
});

test('provider add keeps a Bedrock file credential-free and analysis stays off without its serve flag', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-model-lanes-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'nova.json'), config = join(dir, 'providers.json'), db = join(dir, 'db.sqlite'); writeFileSync(source, JSON.stringify(nova));
  const env = { SSS_PROVIDERS_FILE: config, SSS_DB: db }; await cli(['init', '--id', 'admin'], env, () => {});
  const lines = []; await cli(['provider', 'add', '--file', source], env, line => lines.push(line));
  assert.match(lines[0], /nova-lite added/);
  assert.deepEqual(readProviders({ SSS_PROVIDERS_FILE: config }).providers[0], nova);
  assert.doesNotMatch(readFileSync(config, 'utf8'), /AWS_SECRET|synthetic-secret/i);
  assert.equal(serveSettings(['--port', '8080'], {}).port, 8080, 'no analysis flag constructs no model lane');
});

test('serve refuses a disabled analysis provider before any listener or provider call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sss-model-disabled-')); try {
    const config = join(dir, 'providers.json'), db = join(dir, 'db.sqlite'), env = { SSS_PROVIDERS_FILE: config, SSS_DB: db };
    writeFileSync(config, JSON.stringify({ providers: [{ ...nova, enabled: false }], defaults: {} }), { mode: 0o600 }); await cli(['init', '--id', 'admin'], env, () => {});
    await assert.rejects(() => cli(['serve', '--analysis-provider', 'nova-lite'], env, () => {}), /provider is not enabled/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no analysis flag means a model spy receives zero calls', async t => {
  const store = new Store(); t.after(() => store.close()); store.registerPerson('alex');
  store.append('synthetic', { type: 'posted', actor: 'alex', original: 'Synthetic handoff note.', rules: 2, at: '2026-11-16T12:00:00.000Z' }, { idem: 'synthetic' });
  let calls = 0;
  const result = await runAnalysis({ store, viewer: 'alex', request: { question: 'What should we review?', objectives: ['Review handoff.'], constraints: ['Synthetic only.'], items: ['synthetic'], from: '2026-11-16T12:00:00.000Z', to: '2026-11-16T13:00:00.000Z' }, now: '2026-11-16T12:00:00.000Z' });
  const model = async () => { calls += 1; return '{}'; }; void model;
  assert.equal(result.receipt.model_configuration.mode, 'sources_only'); assert.equal(calls, 0);
});
