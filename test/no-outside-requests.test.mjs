import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Browser scripts in this repo may only call their own server. An absolute URL in a fetch, import or event stream
// would send a visitor's data somewhere else, so no client script may contain one.
const outside = /\b(fetch|import|EventSource|WebSocket|sendBeacon)\s*\(\s*[`'"]\s*(https?:|wss?:)?\/\//;
const clientDirs = ['public', 'demo', 'demo/lib'];

test('no browser script makes a request to another origin', () => {
  const root = new URL('..', import.meta.url).pathname;
  let scanned = 0;
  for (const dir of clientDirs) {
    for (const name of readdirSync(join(root, dir))) {
      if (!name.endsWith('.js')) continue;
      const source = readFileSync(join(root, dir, name), 'utf8'); scanned += 1;
      assert.doesNotMatch(source, outside, `${dir}/${name} calls another origin`);
    }
  }
  assert.ok(scanned >= 10, `the scan found the client scripts (${scanned})`);
});
