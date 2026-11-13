import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createHash } from 'node:crypto';

const fail = message => { throw new Error(message); };
const bytes = value => Buffer.byteLength(value, 'utf8');
export const HTML_CAP = 64 * 1024;
const cap = HTML_CAP;
export const SYSTEM_PROMPT = 'Return one self-contained static HTML page. Use only the approved specification in the user message. Do not include scripts, external URLs, commentary, markdown, people, or comments.';

export function validateHtml(html) {
  if (typeof html !== 'string' || !/^<!doctype html>/i.test(html)) fail('builder response is not static HTML');
  if (bytes(html) > cap) fail('builder response exceeds static HTML cap');
  // The artifact viewer already has a restrictive CSP. Rejecting all script is simpler
  // and means a generated page cannot fetch after it has been delivered.
  if (/<script\b|\bon\w+\s*=|\b(?:https?:)?\/\//i.test(html)) fail('builder response is not a local static page');
  if (!staticMarkupOnly(html)) fail('builder response is not a local static page');
  return html;
}

// Allowlist for model-built pages. The old regex above reads raw text, so an entity-encoded
// value, a backslash, or an element it never named still got through. This parses each tag
// and refuses anything outside the lists below. Text between tags is not markup, so it is not checked.
const ALLOWED_TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'header', 'footer',
  'section', 'article', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'strong', 'em', 'b', 'i', 'small', 'br', 'hr', 'code',
  'pre', 'blockquote', 'figure', 'figcaption']);
const ALLOWED_ATTRIBUTES = new Set(['class', 'id', 'style', 'lang', 'charset', 'name', 'content', 'colspan', 'rowspan', 'scope']);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/y;
const ATTRIBUTE = /\s+([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
function staticMarkupOnly(html) {
  if (/\\/.test(html)) return false;
  for (let at = html.indexOf('<'); at >= 0; at = html.indexOf('<', at + 1)) {
    const next = html[at + 1] || '';
    if (next === '!') {
      if (at === 0 && /^<!doctype html>/i.test(html)) continue;
      return false;
    }
    if (next === '?' || (next === '/' && !/[a-zA-Z]/.test(html[at + 2] || ''))) return false;
    if (!/[a-zA-Z\/]/.test(next)) continue;
    TAG.lastIndex = at;
    const match = TAG.exec(html);
    if (!match) return false;
    const [, closing, name, attributes] = match;
    const tag = name.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return false;
    if (closing && attributes.trim()) return false;
    if (tag === 'style' && !closing) {
      // Style text is raw: nothing inside it is a tag, but it must not load anything or escape the sandbox.
      const start = match.index + match[0].length;
      const end = html.toLowerCase().indexOf('</style', start);
      if (end < 0 || /url\s*\(|@import|expression\s*\(/i.test(html.slice(start, end))) return false;
      at = end - 1;
      continue;
    }
    for (const attribute of attributes.matchAll(ATTRIBUTE)) {
      const attributeName = attribute[1].toLowerCase();
      if (!ALLOWED_ATTRIBUTES.has(attributeName)) return false;
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      if (/[&\\]/.test(value)) return false;
      if (attributeName === 'style') {
        if (/url\s*\(|@import|expression\s*\(/i.test(value)) return false;
      } else if (value.includes(':')) return false;
    }
    at = match.index + match[0].length - 1;
  }
  return true;
}

export function gateway(socket, token, input, key, model = 'fixture:text-v1') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, input, max_output_tokens: 1024 });
    const req = request({ socketPath: socket, path: '/v1/generate', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      authorization: `Bearer ${token}`, 'idempotency-key': key,
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const decoded = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || typeof decoded.output !== 'string') return reject(Error('gateway did not return HTML'));
          resolve(decoded.output);
        } catch { reject(Error('invalid gateway response')); }
      });
    });
    req.once('error', reject);
    req.end(body);
  });
}

// Providers often wrap an otherwise valid page in fences or a short sentence.
// This is deliberately narrow: only a complete doctype document is extracted.
export function staticHtmlFromModel(text) {
  if (typeof text !== 'string') fail('gateway did not return model text');
  const start = text.search(/<!doctype html/i);
  if (start < 0) return text.trim();
  const rest = text.slice(start);
  const end = /<\/html\s*>/i.exec(rest);
  // Take the document through its closing tag. Without one, drop a trailing fence and keep the rest.
  return end ? rest.slice(0, end.index + end[0].length) : rest.replace(/\s*```[\s\S]*$/, '').trim();
}

export async function build({ specPath, outputPath, socket, token, model = 'fixture:text-v1' }) {
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  if (!spec || Object.keys(spec).sort().join(',') !== 'how_we_know,must,out_of_scope') fail('approved spec lists required');
  for (const list of Object.values(spec)) if (!Array.isArray(list) || list.some(value => typeof value !== 'string')) fail('approved spec lists required');
  const input = JSON.stringify({ must: spec.must, how_we_know: spec.how_we_know, out_of_scope: spec.out_of_scope });
  const key = `builder:${createHash('sha256').update(input).digest('hex')}`;
  let html;
  try { html = validateHtml(staticHtmlFromModel(await gateway(socket, token, input, key, model))); }
  catch (first) {
    // One repair is a separately metered, deterministic request. It sees only
    // the approved lists and the rejected model text, never comments or people.
    try { html = validateHtml(staticHtmlFromModel(await gateway(socket, token, input, `${key}:repair`, model))); }
    catch (error) { fail(`model output failed static-page validation after one repair: ${error.message}`); }
  }
  await writeFile(outputPath, html, { mode: 0o644, flag: 'wx' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build({ specPath: process.env.SSS_SPEC_PATH || '/work/spec.json', outputPath: process.env.SSS_OUTPUT_PATH || '/out/try.html',
    socket: process.env.SSS_GATEWAY_SOCKET, token: process.env.SSS_GATEWAY_TOKEN, model: process.env.SSS_GATEWAY_MODEL })
    .catch(error => { process.stderr.write(`builder refused: ${error.message}\n`); process.exitCode = 1; });
}
