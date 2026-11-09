// Usage: node scripts/denylist-add.mjs term [term ...]   or   --file terms.txt
// Adds salted hashes to denylist.json. The terms themselves are never stored.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { termHash } from './check-public.mjs';

const path = new URL('../denylist.json', import.meta.url);
const j = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { salt: randomBytes(16).toString('hex'), hashes: [] };
let terms = process.argv.slice(2);
if (terms[0] === '--file') terms = readFileSync(terms[1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const set = new Set(j.hashes);
for (const t of terms) set.add(termHash(j.salt, t));
j.hashes = [...set].sort();
writeFileSync(path, JSON.stringify(j, null, 1) + '\n');
console.log(`denylist now holds ${j.hashes.length} hashed terms`);
