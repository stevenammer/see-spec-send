import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { OpenCodeAdapter } from '../worker/opencode.js';
import { ClaudeCodeAdapter } from '../worker/claudecode.js';
import { builtInBuilderRegistry } from '../worker/adapter-contract.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const promptOf = file => /PROMPT="([^"]*Approved spec \(JSON\): \$SPEC)"/.exec(read(file))?.[1];

test('Claude Code is a registered builder that reuses the OpenCode adapter\'s locked container, capability and repair pass', t => {
  const store = new Store(); t.after(() => store.close());
  const root = mkdtempSync(join(tmpdir(), 'sss-cc-'));
  const adapter = builtInBuilderRegistry(store).select('claude-code', { capabilities: ['approved_spec', 'bundle'] }, { gatewaySocket: join(root, 'gateway.sock'), root });
  assert.ok(adapter instanceof ClaudeCodeAdapter && adapter instanceof OpenCodeAdapter);
  const id = 'a'.repeat(64);
  assert.equal(adapter.name(id), `sss-claudecode-${'a'.repeat(24)}`, 'its containers are named apart from OpenCode\'s');
  assert.match(adapter.paths(id).repair, /REPAIR\.txt$/);
  assert.throws(() => builtInBuilderRegistry(store).select('claude-code', { capabilities: ['approved_spec', 'bundle'] }, { gatewaySocket: 'x', root, providerEnv: {} }), /unsupported claude-code option/);
});

test('the Claude Code image is pinned by digest and its entrypoint holds no key, allows only file tools, and talks only to the local gateway pipe', () => {
  assert.match(read('worker/claudecode-image.digest').trim(), /^sha256:[a-f0-9]{64}$/);
  const dockerfile = read('worker/claudecode/Dockerfile');
  const manifest = JSON.parse(read('worker/claudecode/package.json'));
  assert.match(manifest.dependencies['@anthropic-ai/claude-code'], /^\d+\.\d+\.\d+$/, 'the CLI version is pinned exactly');
  assert.match(dockerfile, /npm ci /, 'installed from the lockfile, not an unpinned npm install');
  assert.doesNotMatch(dockerfile, /npm install/);
  const lock = JSON.parse(read('worker/claudecode/package-lock.json'));
  assert.ok(Object.entries(lock.packages).filter(([k]) => k).every(([, v]) => /^sha512-/.test(v.integrity)), 'every locked package has an integrity hash');
  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^USER 65532:65532$/m);
  const entry = read('worker/claudecode/entrypoint.sh');
  assert.match(entry, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8787/);
  assert.match(entry, /ANTHROPIC_API_KEY="\$SSS_GATEWAY_TOKEN"/, 'the only credential is the run-bound capability');
  assert.match(entry, /--disallowedTools Bash WebFetch WebSearch Task/, 'no shell, no web, no sub-agents');
  assert.match(entry, /--permission-mode acceptEdits/);
  for (const flag of ['DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1']) assert.ok(entry.includes(flag), flag);
  assert.doesNotMatch(entry, /sk-ant|ANTHROPIC_API_KEY=[^"]/, 'no key is written into the image or script');
  assert.match(entry, /\/work\/REPAIR\.txt/, 'it honors the repair pass');
});

test('both agent profiles are given the same build rules, so one cannot drift from the other', () => {
  const opencode = promptOf('worker/opencode/entrypoint.sh'), claudecode = promptOf('worker/claudecode/entrypoint.sh');
  assert.ok(opencode && claudecode, 'both entrypoints carry the rules');
  assert.equal(claudecode, opencode);
  for (const rule of ['The directory ./bundle/ already exists', 'HTML elements allowed:', 'Never use a, img, svg, video, iframe', 'No attribute value may contain a colon']) assert.ok(claudecode.includes(rule), rule);
});
