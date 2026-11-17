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
  ['ops-pack: CEF never includes audit detail', 'core/audit.js', "suser=${esc(row.who)} outcome=${esc(row.outcome)}", "suser=${esc(row.who)} detail=${esc(JSON.stringify(row.detail))} outcome=${esc(row.outcome)}", T(['ops-pack'])],
  ['ops-pack: audit log is append-only', 'app/http.js', "flag: 'a'", "flag: 'w'", T(['ops-pack'])],
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
  ['pilot handoff: caller must be allowed to read the item', 'handoff/export.js', "if (!store.canRead(actor, item)) throw new Error('refused: caller cannot read this item');", '', T(['pilot-handoff'])],
  ['pilot handoff: erased comments are excluded', 'handoff/export.js', "event.type === 'commented' && safe(store, event)", "event.type === 'commented'", T(['pilot-handoff'])],
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
  ['oidc: the signature is verified', 'app/oidc-provider.js', "if (!valid) throw new Error('OIDC token refused');", '', T(['oidc-provider'])],
  ['oidc: the audience is checked', 'app/oidc-provider.js', '!audience.includes(this.config.clientId)', 'false', T(['oidc-provider'])],
  ['oidc: the nonce is checked', 'app/oidc-provider.js', '!equal(claims.nonce, nonce)', 'false', T(['oidc-provider'])],
  ['oidc: unknown key ids cannot flood the provider', 'app/oidc-provider.js', 'this.clock() - this.lastUnknownKidRefresh >= UNKNOWN_KID_REFRESH_MS', 'true', T(['oidc-provider'])],
  ['oidc: keys named in a header are refused', 'app/oidc-provider.js', 'header.jku !== undefined || header.x5u !== undefined || header.jwk !== undefined || header.key !== undefined', 'false', T(['oidc-provider'])],
  ['oidc: a domain rule needs an email', 'app/oidc-provider.js', "if (this.config.allowedEmailDomains && claims.email === undefined) throw new Error('OIDC token refused');", '', T(['oidc-provider'])],
  ['oidc: the tenant is pinned', 'app/oidc-provider.js', '(this.config.tenantId && claims.tid !== this.config.tenantId)', 'false', T(['oidc-provider'])],
  ['oidc: discovery issuer must match exactly', 'app/oidc-provider.js', 'metadata.issuer !== this.config.issuer', 'false', T(['oidc-provider'])],
  ['oidc: password login really disabled', 'app/http.js', "if (disablePasswordLogin) return json(res, 404, { error: 'not found' });", '', T(['oidc-provider'])],
  ['oidc: nobody is provisioned by default', 'app/auth.js', "if (!this.oidc.autoProvision) throw new Error('OIDC person is not provisioned');", '', T(['oidc-provider'])],
  ['oidc: a state can be used once', 'app/oidc.js', 'this.pending.delete(state);', '', T(['oidc-provider'])],
  ['oidc: the browser binding is checked', 'app/oidc.js', '|| pending.binderHash !== sha256(binder)', '', T(['oidc-provider'])],
  ['fuzz: a JSON null or array body is refused', 'app/http.js', "|| value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('bad json'); return value;", ") throw invalid('bad json'); return value;", T(['fuzz-routes'])],
  ['fuzz: a missing password never reaches the hash function', 'app/auth.js', "if (typeof password !== 'string') return false;          // a missing or non-text password never reaches the hash function", '', T(['fuzz-routes'])],
  ['fuzz: a malformed analysis request is a refusal', 'intelligence/run.js', "|| !Array.isArray(request.objectives) || !request.objectives.every(value => typeof value === 'string'))", ')', T(['fuzz-routes'])],
  ['fuzz: redeem with missing fields is a refusal', 'app/auth.js', "if (typeof value !== 'string' || typeof password !== 'string') throw invalid('invite unavailable');", '', T(['fuzz-routes'])],
  ['portability: groups are imported before the events that name them', 'core/store.js', "this.importGroups(groupRows);\n      for (const artifact of artifacts) {", "for (const artifact of artifacts) {", T(['export-portability'])],
  ['portability: erased records leave only their hashes', 'core/store.js', "...(gone ? { redacted: true } : { body })", "...{ body }", T(['export-portability'])],
  ['portability: an imported copy keeps its delivery state', 'core/store.js', "const allowed = new Set(['reanalysis_pairs', 'reanalysis_cursor', 'digest_entries', 'ping_log', 'reanalysis_mute']);", "const allowed = new Set([]);", T(['export-portability'])],
  ['portability: two knowledge logs are never merged', 'core/store.js', "if (knowledgeRows.length && db.prepare('SELECT COUNT(*) AS n FROM knowledge_log').get().n !== 0) throw new Error('knowledge log is not empty');", '', T(['export-portability'])],
  ['portability: an imported log must verify', 'core/store.js', "if (!check.ok) throw new Error('imported knowledge log does not verify');", '', T(['export-portability'])],
  ['erasure: records built from a result are tombstoned too', 'knowledge/corrections.js', "for (const next of [row.derived_hash, body]) if (next && !seen.has(next))", "for (const next of [row.derived_hash]) if (next && !seen.has(next))", T(['export-portability'])],
  ['erasure: saved answers citing the source are tombstoned too', 'knowledge/chain.js', "if (typeof value.item === 'string' && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash)) found.add(value.hash);", '', T(['erasure-completeness'])],
  ['erasure: the text of a tombstoned record is removed, not hidden', 'knowledge/corrections.js', "store.db.prepare(\"UPDATE knowledge_log SET body='' WHERE hash=?\").run(hash);", '', T(['erasure-completeness'])],
  ['erasure: the copy of the erased source is removed', 'knowledge/corrections.js', "store.db.prepare(\"UPDATE knowledge_bodies SET erased=1, bytes='' WHERE body_hash=?\").run(sourceBodyHash);", '', T(['erasure-completeness'])],
  ['erasure: the ledger projection is rebuilt', 'core/store.js', "      rebuildLedger(this);   // the ledger table is a projection of specs: rebuild it from the now-redacted body\n", '', T(['erasure-completeness'])],
  ['review2: password sign-up is closed in single-sign-on-only mode', 'app/http.js', "if (disablePasswordLogin && ['/api/invite/redeem', '/redeem', '/api/password', '/password'].includes(url.pathname)) return json(res, 404, { error: 'not found' });", '', T(['security2-oidc-only-invite-bypass'])],
  ['review2: import strips current leader authority', 'core/store.js', 'if (!keepAuthority) this.db.prepare("UPDATE actors SET leader=0 WHERE kind=\'person\'").run();', '', T(['security2-import-oidc-leader-escalation', 'export-portability'])],
  ['review2: metrics labels use fixed route words only', 'app/http.js', "ROUTE_WORDS.has(part) ? part : ':id'", 'part', T(['security2-ops-route-cardinality', 'ops'])],
  ['review2: metrics keys have a hard ceiling', 'app/ops.js', 'Object.keys(bucket).length < limit', 'true', T(['ops'])],
  ['review2: erasing a source redacts stored copies of it', 'core/store.js', 'this.redactStoredCopies(JSON.parse(body.bytes), targetHash);', '', T(['security2-erasure-decision-packet-leak', 'security2-erasure-orphaned-closeout-artifact'])],
  ['review2: a bad export signature is refused', 'cli.js', "&& !verifyExport(body, JSON.parse(signed[0]).signature, readExportKey(value('--verify-key') || fail('--verify-key needs a key file'), false))", '&& false', T(['export-portability'])],
  ['review2: an unsigned export is refused when a key is given', 'cli.js', "} else if (args.includes('--verify-key')) fail('export is not signed: refusing to import');", '}', T(['export-portability'])],
  ['stepup: provider must report a fresh sign-in time', 'app/oidc.js', 'claims.auth_time < asked - this.clockSkewSeconds', 'false', T(['oidc-stepup'])],
  ['stepup: answer is bound to the same session', 'app/auth.js', 'identity.sessionDigest !== hash(value) || ', '', T(['oidc-stepup'])],
  ['stepup: answer is bound to the same person', 'app/auth.js', "|| identity.id !== session.person) throw invalid('step-up unavailable');", ") throw invalid('step-up unavailable');", T(['oidc-stepup'])],
  ['stepup: a step-up answer is never a sign-in', 'app/auth.js', "if (identity.purpose !== 'login') throw new Error('OIDC response refused');", '', T(['oidc-stepup'])],
  ['stepup: return path must be a local item page', 'app/http.js', '!/^\\/(?:items\\/[A-Za-z0-9_-]{1,128}|admin)$/.test(next)', 'false', T(['oidc-stepup'])],
  ['stepup: password sessions cannot use the provider path', 'app/auth.js', "session.auth_method !== 'oidc' || !this.allowed(ip, session.person, 'stepup')", "!this.allowed(ip, session.person, 'stepup')", T(['oidc-stepup'])],
  ['rfc9207: callback issuer must match', 'app/oidc.js', "if (iss !== undefined && iss !== null && iss !== this.issuer) throw new Error('OIDC response refused');", '', T(['oidc-stepup'])],
  ['retention: legal holds block erasure', 'core/store.js', "if (this.isHeld(item)) throw refused('legal hold blocks erasure');", '', T(['admin-retention'])],
  ['retention: zero days leaves a kind off', 'core/store.js', 'if (settings.comments > 0)', 'if (settings.comments >= 0)', T(['admin-retention'])],
  ['admin: a leader cannot demote or disable themselves', 'app/http.js', "if (input.id === session.person && ['demote', 'disable'].includes(input.action)) return json(res, 403, { error: 'request refused' });", '', T(['admin-http'])],
  ['admin: person changes need a fresh step-up', 'app/http.js', "        if (!auth.useStepup(sessionToken)) return json(res, 403, { error: 'request refused' });\n        if (input.action === 'promote')", "        if (input.action === 'promote')", T(['admin-http'])],
  ['pilot: reset needs explicit confirmation', 'cli.js', "if (!args.includes('--confirm-erase-everything')) fail(", "if (false) fail(", T(['pilot-handoff'])],
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
