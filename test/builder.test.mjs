import test from 'node:test';
import assert from 'node:assert/strict';
import { staticHtmlFromModel, validateHtml, SYSTEM_PROMPT } from '../worker/builder/index.js';

test('builder strips only surrounding markdown or commentary and still rejects unsafe model text', () => {
  const page = '<!doctype html><html><head><title>Try</title></head><body>ok</body></html>';
  assert.equal(staticHtmlFromModel(`Here it is.\n\`\`\`html\n${page}\n\`\`\``), page);
  assert.equal(validateHtml(staticHtmlFromModel(`note ${page} trailing`)), page);
  assert.throws(() => validateHtml(staticHtmlFromModel('<!doctype html><script>alert(1)</script>')), /static page/);
  assert.match(SYSTEM_PROMPT, /approved specification/);
});
