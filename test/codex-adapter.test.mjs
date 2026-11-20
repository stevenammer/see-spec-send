import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { OpenCodeAdapter } from '../worker/opencode.js';
import { CodexAdapter } from '../worker/codex.js';
import { builtInBuilderRegistry } from '../worker/adapter-contract.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const promptOf = file => /PROMPT="([^"]*Approved spec \(JSON\): \$SPEC)"/.exec(read(file))?.[1];
// The one sentence that names the agent's own file tool differs per agent; everything else must match exactly.
const withoutToolSentence = prompt => prompt.replace(/Create every file in it [^:]*:/, 'Create every file in it <by the agent\'s own means>:');

test('Codex is a registered builder that reuses the OpenCode adapter\'s locked container, capability and repair pass', t => {
  const store = new Store(); t.after(() => store.close());
  const root = mkdtempSync(join(tmpdir(), 'sss-codex-'));
  const adapter = builtInBuilderRegistry(store).select('codex', { capabilities: ['approved_spec', 'bundle'] }, { gatewaySocket: join(root, 'gateway.sock'), root });
  assert.ok(adapter instanceof CodexAdapter && adapter instanceof OpenCodeAdapter);
  const id = 'b'.repeat(64);
  assert.equal(adapter.name(id), `sss-codex-${'b'.repeat(24)}`, 'its containers are named apart from the other profiles\'');
  assert.match(adapter.paths(id).repair, /REPAIR\.txt$/);
  assert.throws(() => builtInBuilderRegistry(store).select('codex', { capabilities: ['approved_spec', 'bundle'] }, { gatewaySocket: 'x', root, providerEnv: {} }), /unsupported codex option/);
});

test('the Codex image is pinned, and its entrypoint holds no key, speaks only to the local gateway pipe, and gives Codex no web', () => {
  assert.match(read('worker/codex-image.digest').trim(), /^sha256:[a-f0-9]{64}$/);
  const dockerfile = read('worker/codex/Dockerfile');
  const manifest = JSON.parse(read('worker/codex/package.json'));
  assert.match(manifest.dependencies['@openai/codex'], /^\d+\.\d+\.\d+$/, 'the CLI version is pinned exactly');
  assert.match(dockerfile, /npm ci /, 'installed from the lockfile, not an unpinned npm install');
  assert.doesNotMatch(dockerfile, /npm install/);
  const lock = JSON.parse(read('worker/codex/package-lock.json'));
  assert.ok(Object.entries(lock.packages).filter(([k]) => k).every(([, v]) => /^sha512-/.test(v.integrity)), 'every locked package has an integrity hash');
  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^USER 65532:65532$/m);
  const entry = read('worker/codex/entrypoint.sh');
  assert.match(entry, /model_providers\.sss\.base_url="http:\/\/127\.0\.0\.1:8787\/v1"/);
  assert.match(entry, /model_providers\.sss\.env_key="SSS_GATEWAY_TOKEN"/, 'the only credential is the run-bound capability, read from the environment');
  assert.match(entry, /model_providers\.sss\.wire_api="responses"/);
  assert.match(entry, /web_search="disabled"/);
  for (const flag of ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check']) assert.ok(entry.includes(flag), flag);
  assert.doesNotMatch(entry, /sk-[A-Za-z0-9]|OPENAI_API_KEY=/, 'no key is written into the image or script');
  assert.match(entry, /\/work\/REPAIR\.txt/, 'it honors the repair pass');
});

test('Codex\'s own sandbox is off only because the container is the sandbox, and the entrypoint says so', () => {
  const entry = read('worker/codex/entrypoint.sh');
  assert.match(entry, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(entry, /the container is the sandbox/);
  assert.match(entry, /no network, read-only root, dropped\s+# capabilities, one writable \/work/);
});

test('every agent profile is given the same build rules, apart from the one sentence about its own file tool', () => {
  const opencode = promptOf('worker/opencode/entrypoint.sh'), claudecode = promptOf('worker/claudecode/entrypoint.sh'), codex = promptOf('worker/codex/entrypoint.sh');
  assert.ok(opencode && claudecode && codex);
  assert.equal(withoutToolSentence(codex), withoutToolSentence(opencode));
  assert.equal(withoutToolSentence(claudecode), withoutToolSentence(opencode));
  assert.match(codex, /writing the files with your shell and never pasting file contents into your reply/);
  for (const rule of ['The directory ./bundle/ already exists', 'HTML elements allowed:', 'Never use a, img, svg, video, iframe', 'No attribute value may contain a colon']) assert.ok(codex.includes(rule), rule);
});
