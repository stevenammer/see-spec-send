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

test('extraction finds a doctype page after commentary even when the closing tag is missing', () => {
  const page = '<!doctype html><title>t</title><h1>t</h1>';
  assert.equal(staticHtmlFromModel(`Here you go:\n\`\`\`html\n${page}\n\`\`\``), page);
  assert.equal(staticHtmlFromModel(`Sure.\n${page}</html> trailing words`), `${page}</html>`);
});

test('validation accepts the uppercase doctype that real models write, and still rejects a non-document', () => {
  const page = '<!DOCTYPE html><html><head><title>t</title><style>h1{color:#333}</style></head><body><h1>t</h1></body></html>';
  assert.equal(validateHtml(staticHtmlFromModel(`Here:\n${page}`)), page);
  assert.throws(() => validateHtml('<html><body>no doctype</body></html>'), /not static HTML/);
});
