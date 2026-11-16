// Scoped mutation check for the November 2026 modules. Each mutant breaks one real rule in a throwaway
// copy of the tree and must be KILLED by the named tests. The older full-suite runner is mutate-check.mjs.
//   node scripts/mutate-new.mjs [--only TEXT] [--check-sources]
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const T = names => names.map(name => `test/${name}.test.mjs`);
const reconcile = T(['reconcile']), scenarios = T(['reanalysis-scenarios']), delivery = T(['reanalysis-delivery']);
const mutants = [
  // name, file, find, replace, tests that must fail
  ['fork: a pending alternative may not fork', 'core/reconcile.js', "const FORKABLE = new Set(['declined', 'unresolved_at_freeze', 'unresolved_after_window']);", "const FORKABLE = new Set(['pending', 'declined', 'unresolved_at_freeze', 'unresolved_after_window']);", reconcile],
  ['fork: the 14-day window is enforced', 'core/reconcile.js', 'age >= RECONCILE_DAYS * DAY_MS ? ', 'age >= 0 ? ', reconcile],
  ['fork: an explicit decline is recognized', 'core/reconcile.js', "declined.has(event.body_hash) ? 'declined'", "false ? 'declined'", reconcile],
  ['fork: only the steward can decline', 'core/machine.js', "event.parent === undefined || event.actor !== state.steward", 'event.parent === undefined', reconcile],
  ['gateway: per-run call limit', 'gateway/ledger.js', "demand(mine.length < policy.max_calls_per_run, 'run call limit exceeded')", "demand(true, 'run call limit exceeded')", T(['gateway-run-limits'])],
  ['gateway: per-run token limit', 'gateway/ledger.js', "<= policy.max_tokens_per_run, 'run token limit exceeded'", "<= Infinity, 'run token limit exceeded'", T(['gateway-run-limits'])],
  ['proxy: output limit is clamped to policy', 'gateway/http.js', 'request.max_tokens = Math.min(asked, policy.output_tokens);', 'request.max_tokens = asked;', T(['proxy-chat'])],
  ['proxy: provider usage is normalized', 'gateway/http.js', 'Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens)', 'false', T(['proxy-chat'])],
  ['proxy: a refusal after the stream began ends it', 'gateway/http.js', 'if (res.headersSent) res.end();', 'if (false) res.end();', T(['proxy-chat'])],
  ['proxy: unknown request keys are refused', 'gateway/http.js', "if (Object.keys(raw).some(key => !chatKeys.includes(key) && !ignorableKeys.includes(key))) throw Error('invalid chat payload');", '', T(['proxy-chat'])],
  ['provider: pinned address prefers IPv4', 'provider/safe-http.js', 'answers.find(answer => isIP(answer.address) === 4) || answers[0]', 'answers[0]', T(['provider'])],
  ['bedrock: session token is signed', 'provider/bedrock.js', "...(sessionToken ? { 'x-amz-security-token': sessionToken } : {})", '', T(['bedrock'])],
  ['reanalysis: a result never reanalyzes its own case', 'reanalysis/match.js', 'const qualifies = common.length >= 3 && allowed && !duplicate && !ownSource', 'const qualifies = common.length >= 3 && allowed && !duplicate', scenarios],
  ['reanalysis: three shared terms needed', 'reanalysis/match.js', 'const qualifies = common.length >= 3 && allowed', 'const qualifies = common.length >= 1 && allowed', scenarios],
  ['reanalysis: generation above 2 is held', 'reanalysis/match.js', 'delta.generation <= 2', 'true', scenarios],
  ['reanalysis: a challenged result is not support', 'reanalysis/match.js', 'if (isChallenged(store, delta.hash, delta.source?.body_hash)) return { checked: [], held: [] };', '', [...scenarios, ...T(['corrections'])]],
  ['reanalysis: weekly limit per open thread', 'reanalysis/open.js', 'parseAt(now) - parseAt(recent.created_at) < WEEK', 'false', T(['reanalysis-open'])],
  ['reanalysis: open thread needs three shared terms', 'reanalysis/open.js', 'common.length < MIN_SHARED_TERMS', 'common.length < 1', T(['reanalysis-open'])],
  ['reanalysis: scheduler never overlaps passes', 'reanalysis/schedule.js', "if (busy) return 'skipped';", '', T(['reanalysis-schedule'])],
  ['reanalysis: scheduler lock excludes a live holder', 'reanalysis/schedule.js', 'if (Number.isInteger(owner) && owner > 0 && alive(owner)) return false;', '', T(['reanalysis-schedule'])],
  ['digest: one ping per person per day', 'notifications/digest.js', 'const ping = !muted && !alreadyPinged;', 'const ping = !muted;', delivery],
  ['digest: muted people are never pinged', 'notifications/digest.js', 'const ping = !muted && !alreadyPinged;', 'const ping = !alreadyPinged;', delivery],
  ['digest: not-relevant only removes the steward\'s own entry', 'app/http.js', "store.read(annex.body.parent.item).context.steward === session.person", 'true', delivery],
  ['renewal: only the steward or author may renew', 'core/store.js', "if (![parentContext.steward, parentEvents[0]?.actor].includes(event.actor)) throw refused('only the parent steward or original author may renew');", '', delivery],
  ['renewal: one per annex per person', 'core/store.js', "throw refused('renewal already exists for this annex');", 'void 0;', delivery],
  ['renewal: the annex must target the parent', 'core/store.js', "annex.body.parent?.item !== parent.item", 'false', delivery],
  ['read scope: members only for restricted work', 'access/read.js', 'item.members.includes(id)', 'true', T(['read-scope'])],
  ['correction: source events may be targeted', 'app/http.js', '(!target && !source) || !item', '!target || !item', delivery],
  ['bundle origin: label signature is verified', 'app/bundle-origin.js', '!timingSafeEqual(expected, received)', 'false', T(['bundle-origin'])],
  ['bundle: capabilities that can reach out are refused', 'worker/bundle.js', "\\bsendBeacon\\b|", '', T(['bundle-html'])],
  ['bundle: scripts must be empty elements', 'worker/builder/index.js', "if (end < 0 || html.slice(match.index + match[0].length, end).trim()) return false;", '', T(['bundle-html'])],
  ['bundle: links must name bundle files', 'worker/builder/index.js', 'if (!links.has(value)) return false; continue;', 'continue;', T(['bundle-html'])],
  ['prompt: the question comes from the request, not the model', 'intelligence/prompt.js', 'question: packet.request.question, objectives: packet.request.objectives, constraints: packet.request.constraints,', 'question: answer.question, objectives: answer.objectives, constraints: answer.constraints,', T(['prompt-shape'])],
  ['prompt: an unknown status is never coerced into an allowed one', 'intelligence/prompt.js', '?.[1].toLowerCase() ?? value) : value;', "?.[1].toLowerCase() ?? 'documented') : value;", T(['prompt-shape'])],
  ['analysis: a reply that repeats the template is refused', 'intelligence/run.js', "if (repeatsTemplate(packet, checked.answer)) throw refused('answer repeats the template text instead of findings');", '', T(['prompt-shape'])],
  ['analysis: motive questions are refused before any model call', 'intelligence/run.js', '|\\bmotives?\\b|', '|', T(['prompt-shape'])],
  ['verify: one outer fence is accepted', 'reanalysis/verify.js', 'JSON.parse(unfence(raw))', 'JSON.parse(raw)', T(['prompt-shape'])],
  ['security: restricted items are not readable through the generic item route', 'app/http.js', "if (store.readScope(match[1]) && !readable(match[1])) return json(res, 403, { error: 'request refused' });", '', T(['security-restricted-item-api-idOR'])],
  ['security: restricted items do not leak through the related route', 'app/http.js', "if (store.readScope(relatedView[1]) && !readable(relatedView[1])) return json(res, 403, { error: 'request refused' });", '', T(['security-restricted-related-route-idor'])],
  ['security: annex target readers must be able to read the source', 'reanalysis/match.js', '&& audienceCovers(scopeOf(delta.source.item), scopeOf(target.item));', ';', T(['security-reanalysis-cross-scope-annex'])],
  ['security: open-thread readers must be able to read the source', 'reanalysis/open.js', 'if (!audienceCovers(store.readScope(delta.source.item), store.readScope(target.item))) continue;', '', T(['reanalysis-open'])],
];
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
if (process.argv.includes('--check-sources')) {
  const missing = mutants.filter(([, file, find]) => !readFileSync(join(root, file), 'utf8').includes(find)).map(([name]) => name);
  if (missing.length) { console.error(`mutant source missing: ${missing.join('; ')}`); process.exit(1); }
  console.log(`OK ${mutants.length} mutant find strings found`); process.exit(0);
}
const run = (cwd, tests) => spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd, encoding: 'utf8', timeout: 600_000 });
let survived = 0, killed = 0;
for (const [name, file, find, replace, tests] of mutants) {
  if (only && !name.includes(only)) continue;
  const copy = mkdtempSync(join(tmpdir(), 'sss-mutant-'));
  cpSync(root, copy, { recursive: true, filter: path => !path.includes('/.git') && !path.includes('/node_modules') && !path.includes('/docs/screens') });
  const path = join(copy, file); const source = readFileSync(path, 'utf8');
  if (!source.includes(find)) throw new Error(`mutant source missing: ${name}`);
  writeFileSync(path, source.replace(find, replace));
  const result = run(copy, tests);
  const dead = result.status !== 0;
  console.log(`${dead ? 'KILLED  ' : 'SURVIVED'} ${name}`);
  if (dead) killed += 1; else survived += 1;
  rmSync(copy, { recursive: true, force: true });
}
console.log(`${killed} killed, ${survived} survived`);
if (survived) process.exitCode = 1;
