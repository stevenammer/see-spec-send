import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createHash } from 'node:crypto';

const fail = message => { throw new Error(message); };
const bytes = value => Buffer.byteLength(value, 'utf8');
const cap = 64 * 1024;

export function validateHtml(html) {
  if (typeof html !== 'string' || !html.startsWith('<!doctype html>')) fail('builder response is not static HTML');
  if (bytes(html) > cap) fail('builder response exceeds static HTML cap');
  // The artifact viewer already has a restrictive CSP. Rejecting all script is simpler
  // and means a generated page cannot fetch after it has been delivered.
  if (/<script\b|\bon\w+\s*=|\b(?:https?:)?\/\//i.test(html)) fail('builder response is not a local static page');
  return html;
}

export function gateway(socket, token, input, key) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'fixture:text-v1', input, max_output_tokens: 128 });
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

export async function build({ specPath, outputPath, socket, token }) {
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  if (!spec || Object.keys(spec).sort().join(',') !== 'how_we_know,must,out_of_scope') fail('approved spec lists required');
  for (const list of Object.values(spec)) if (!Array.isArray(list) || list.some(value => typeof value !== 'string')) fail('approved spec lists required');
  const input = JSON.stringify({ must: spec.must, how_we_know: spec.how_we_know, out_of_scope: spec.out_of_scope });
  const key = `builder:${createHash('sha256').update(input).digest('hex')}`;
  const html = validateHtml(await gateway(socket, token, input, key));
  await writeFile(outputPath, html, { mode: 0o644, flag: 'wx' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build({ specPath: process.env.SSS_SPEC_PATH || '/work/spec.json', outputPath: process.env.SSS_OUTPUT_PATH || '/out/try.html',
    socket: process.env.SSS_GATEWAY_SOCKET, token: process.env.SSS_GATEWAY_TOKEN })
    .catch(error => { process.stderr.write(`builder refused: ${error.message}\n`); process.exitCode = 1; });
}
