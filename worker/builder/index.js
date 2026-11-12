import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createHash } from 'node:crypto';

const fail = message => { throw new Error(message); };
const bytes = value => Buffer.byteLength(value, 'utf8');
const cap = 64 * 1024;
export const SYSTEM_PROMPT = 'Return one self-contained static HTML page. Use only the approved specification in the user message. Do not include scripts, external URLs, commentary, markdown, people, or comments.';

export function validateHtml(html) {
  if (typeof html !== 'string' || !/^<!doctype html>/i.test(html)) fail('builder response is not static HTML');
  if (bytes(html) > cap) fail('builder response exceeds static HTML cap');
  // The artifact viewer already has a restrictive CSP. Rejecting all script is simpler
  // and means a generated page cannot fetch after it has been delivered.
  if (/<script\b|\bon\w+\s*=|\b(?:https?:)?\/\//i.test(html)) fail('builder response is not a local static page');
  return html;
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
