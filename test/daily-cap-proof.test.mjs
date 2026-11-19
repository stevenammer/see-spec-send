import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createHandler } from '../app/http.js';
import { budget, kindOf } from '../core/errors.js';
import { budgetSentence } from '../gateway/budget.js';
import { renderEffortStatus } from '../app/pages-effort.js';
import { runAnalysis } from '../intelligence/run.js';
import { Ledger, fixturePolicy } from '../gateway/ledger.js';
import { AnalysisGateway } from '../gateway/analysis.js';
import { setKill } from '../worker/control.js';
import { errorFor } from '../gateway/anthropic.js';
import { proveDailyCap, DAY_CAP } from '../scripts/prove-daily-cap.mjs';

test('the repeatable proof passes every check: one UTC-day cap across all lanes, with zero network', { timeout: 120_000 }, async () => {
  const lines = [];
  const result = await proveDailyCap({ log: line => lines.push(line) });
  assert.deepEqual(result.failed.map(check => check.name), []);
  assert.ok(result.checks.length >= 40, `only ${result.checks.length} checks ran`);
  const text = lines.join('\n');
  assert.match(text, /"day_micros":15000000/);
  assert.match(text, /REPLACING THE DATABASE RESETS THE DAILY COUNTER/);
  assert.match(text, /2g2\. Same case \(g\), but through the REAL hosted-demo reset script/);
  assert.match(text, /\[PASS\] the exhausted day still refuses after the real reset/);
  assert.equal(DAY_CAP, 15_000_000);
});

test('every budget refusal reads as a plain sentence and never as a raw reason', () => {
  assert.match(budgetSentence('day cap exceeded'), /^Today's AI budget is used up\. It starts over at midnight UTC\.$/);
  assert.match(budgetSentence('global cap exceeded'), /budget for this site is used up/);
  for (const reason of ['person daily call limit', 'mention daily call limit', 'analysis daily call limit', 'automatic item call limit']) assert.match(budgetSentence(reason), /used all of your AI calls for today/, reason);
  for (const reason of ['person daily budget exceeded', 'analysis daily budget exceeded']) assert.match(budgetSentence(reason), /your share of the AI budget for today/, reason);
  for (const reason of ['gateway disabled', 'stopped run']) assert.equal(budgetSentence(reason), 'AI is switched off right now.');
  assert.equal(budgetSentence('model has no reviewed price'), null);
  assert.equal(kindOf(budget('day cap exceeded')), 'budget');
});

test('the Quest draft route answers 429 with the plain sentence, not "request refused"', async () => {
  const store = new Store(); const auth = new Auth(store);
  try {
    await auth.createUser('member', 'synthetic-long-passphrase-7');
    const call = async (handler, path, input, headers) => {
      const req = Readable.from([JSON.stringify(input)]); req.method = 'POST'; req.url = path;
      req.headers = { 'content-type': 'application/json', ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
      const res = { headers: {}, text: '', status: 200, setHeader(k, v) { this.headers[k] = v; }, writeHead(status, values = {}) { this.status = status; Object.assign(this.headers, values); }, end(value = '') { this.text += value; } };
      await handler(req, res); return { ...res, json: res.text ? JSON.parse(res.text) : null };
    };
    const login = await call(createHandler({ store, auth }), '/api/login', { id: 'member', password: 'synthetic-long-passphrase-7' }, {});
    const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'https://localhost', 'x-csrf-token': login.json.csrf };
    const questModel = { preflight: () => ({}), draft: async () => { throw budget('day cap exceeded'); } };
    const answer = await call(createHandler({ store, auth, questModel }), '/api/quest/model/draft', {}, headers);
    assert.equal(answer.status, 429);
    assert.deepEqual(answer.json, { error: "Today's AI budget is used up. It starts over at midnight UTC.", code: 'ai_budget' });
  } finally { store.close(); }
});

test('Investigate keeps working at the limit: sources only, with the budget sentence as the label', async () => {
  const at = '2026-11-16T12:00:00.000Z';
  const store = new Store();
  try {
    store.registerPerson('alex');
    store.append('open', { type: 'posted', actor: 'alex', rules: 2, original: 'Synthetic handoff record.', at }, { idem: 'open' });
    const request = { question: 'Which documented handoff conditions should we investigate?', objectives: ['Improve handoff completeness.'], constraints: ['Preserve employee privacy.'], items: ['open'], from: at, to: '2026-11-16T13:00:00.000Z' };
    const result = await runAnalysis({ store, viewer: 'alex', request, now: at, askModel: async () => { throw budget('day cap exceeded'); } });
    assert.equal(result.receipt.model_configuration.mode, 'budget_used_sources_only');
    assert.match(result.receipt.label, /^Today's AI budget is used up\. It starts over at midnight UTC\. Sources-only answer shown/);
    // A defect (not a budget refusal) is still a defect, not silently swallowed.
    await assert.rejects(() => runAnalysis({ store, viewer: 'alex', request, now: at, askModel: async () => { throw Error('boom'); } }), /boom/);
  } finally { store.close(); }
});

test('the kill switch stops the analysis lane too, before any provider call', async () => {
  const store = new Store();
  try {
    const ledger = new Ledger(store); ledger.configure(fixturePolicy());
    let calls = 0;
    const gateway = new AnalysisGateway(ledger, async () => { calls += 1; return { output: 'x', usage: { input_tokens: 1, output_tokens: 1 } }; });
    setKill(store, true);
    await assert.rejects(() => gateway.ask('person', 'k1', { p: 'hello' }), error => error.kind === 'budget' && /stopped run/.test(error.message));
    assert.equal(calls, 0);
  } finally { store.close(); }
});

test('Effort shows the budget sentence for a blocked reply, and the builder agent is told the day budget is used up', () => {
  const html = renderEffortStatus([{ kind: 'see_first', state: 'blocked', last_error: 'day cap exceeded' }]);
  assert.match(html, /blocked, not retrying/);
  assert.match(html, /Today&#39;s AI budget is used up\. It starts over at midnight UTC\./);
  assert.doesNotMatch(html, /day cap exceeded/);
  const day = errorFor(Error('day cap exceeded')); const lifetime = errorFor(Error('global cap exceeded')); const run = errorFor(Error('run cap exceeded'));
  assert.equal(day.status, 402); assert.match(day.body.error.message, /today's AI budget for this site is used up/);
  assert.match(lifetime.body.error.message, /AI budget for this site is used up/);
  assert.equal(run.body.error.message, 'the approved budget for this build is used up');
});
