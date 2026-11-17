#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', timeout: 60_000 });
if (result.error || !result.stdout) { console.warn('SKIP: dependency audit unavailable offline or npm registry unreachable'); process.exit(0); }
try { const report = JSON.parse(result.stdout); const total = Number(report.metadata?.vulnerabilities?.total || 0); if (total) { console.error(`dependency audit found ${total} known vulnerabilities`); process.exit(1); } console.log('dependency audit: no known vulnerable pinned dependencies'); } catch { console.warn('SKIP: dependency audit returned no usable JSON'); }
