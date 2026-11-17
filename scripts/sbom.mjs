#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const lockFile = new URL('../package-lock.json', import.meta.url);
const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile)) : JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const components = Object.entries(lock.packages || {}).filter(([path]) => path).map(([path, value]) => ({ type: 'library', name: path.replace(/^node_modules\//, ''), version: value.version || 'unknown', purl: value.version ? `pkg:npm/${path.replace(/^node_modules\//, '')}@${value.version}` : undefined }));
const out = { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${crypto.randomUUID()}`, version: 1, metadata: { component: { type: 'application', name: lock.name || 'seespecsend', version: lock.version || '0.0.0' }, properties: [{ name: 'sss:container-base', value: 'node:22-alpine (pinned in Dockerfile)' }] }, components };
const target = process.argv[2] || 'sbom.cdx.json'; writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`); console.log(target);
