// Writes /work/manifest.json for the files the agent produced under /work/bundle.
// The host validates these hashes independently and trusts nothing here.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = '/work/bundle', files = [];
(function walk(dir, rel = '') {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), info = lstatSync(path), relative = rel ? `${rel}/${name}` : name;
    if (info.isDirectory()) walk(path, relative);
    else if (info.isFile()) { const data = readFileSync(path); files.push({ path: relative, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }); }
  }
})(root);
if (!files.length) process.exit(3);
writeFileSync('/work/manifest.json', JSON.stringify({ version: 1, files }));
