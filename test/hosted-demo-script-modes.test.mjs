import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The first real deployment failed because two shell scripts were not marked executable in git.
test('every shell script under deploy/hosted-demo is executable', () => {
  const dir = new URL('../deploy/hosted-demo/', import.meta.url).pathname;
  const scripts = readdirSync(dir).filter(name => name.endsWith('.sh'));
  assert.ok(scripts.includes('tunnel-url.sh') && scripts.includes('backup.sh') && scripts.includes('demo.sh'));
  for (const name of scripts) assert.ok(statSync(join(dir, name)).mode & 0o111, `${name} is not executable`);
});
