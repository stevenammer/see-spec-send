import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const fullSuite = ['--test', '--test-concurrency=1', 'test/auth.test.mjs', 'test/hardening.test.mjs', 'test/store.test.mjs',
  'test/machine.test.mjs', 'test/oracle.test.mjs', 'test/web.test.mjs', 'test/web-pages.test.mjs',
  'test/review-regressions.test.mjs', 'test/legacy-migration.test.mjs', 'test/vision-quest.test.mjs', 'test/quest-http.test.mjs',
  'test/quest-storage-faults.test.mjs', 'test/quest-attack.test.mjs', 'test/quest-spec.test.mjs',
  'test/quest-review-regressions.test.mjs', 'test/worker.test.mjs', 'test/container.test.mjs',
  'test/worker-path.test.mjs', 'test/gateway.test.mjs', 'test/slice9.test.mjs', 'test/slice7.test.mjs', 'test/slice8.test.mjs',
  'test/provider.test.mjs',
  'test/slice13.test.mjs',
  'test/slice14.test.mjs',
  'test/redteam-evidence-forgery.test.mjs', 'test/redteam-oidc-login-csrf.test.mjs',
  'test/mutation-security.test.mjs'];
const workerOnly = process.argv.includes('--worker');
const suite = workerOnly ? ['--test', '--test-concurrency=1',
  'test/worker.test.mjs', 'test/worker-path.test.mjs', 'test/container.test.mjs'] : fullSuite;
const mutants = [
  ['gateway disabled default', "demand(policy.enabled, 'gateway disabled');", ''],
  ['gateway run cap', "demand(add(used, worst) <= cap, 'run cap exceeded');", ''],
  ['gateway global cap', "demand(add(sum(rows), worst) <= policy.global_micros, 'global cap exceeded');", ''],
  ['gateway day cap', "demand(add(sum(rows.filter(row => row.day === day)), worst) <= policy.day_micros, 'day cap exceeded');", ''],
  ['gateway concurrency', "['reserved', 'dispatched'].includes(row.state)).length < policy.concurrency", "['reserved', 'dispatched'].includes(row.state)).length < policy.concurrency + 1000"],
  ['gateway legacy spend counted', 'add(legacyMicros(this.store, run.item, run.approval),', 'add(0,'],
  ['gateway idempotency payload', "demand(existing.payload_hash === payloadHash, 'idempotency payload conflict');", ''],
  ['gateway single dispatch claim', "demand(row.state === 'reserved', 'dispatch already claimed');", ''],
  ['gateway settle only dispatched', "if (row.state !== 'dispatched') return false;", ''],
  ['gateway capability revoked', 'cap && cap.revoked === 0 &&', 'cap &&'],
  ['gateway capability expiry', 'cap.expires > this.clock()', 'true'],
  ['gateway capability binding', 'cap.approval === run.approval && cap.spec_hash === run.spec_hash', 'true'],
  ['gateway cancelled releases only on no call', "{ state: 'cancelled', charged_micros: 0 }", "{ state: 'cancelled' }"],
  ['worker canonical kill path', '`${realpathSync(file)}.kill`', '`${file}.kill`'],
  ['worker current approval', "&& context.approval === run.approval && context.specHash === run.spec_hash", '&& true'],
  ['worker stopped delivery', "run.status !== 'active' || killed(this.store) || !current(context, run)", 'false'],
  ['worker single run', "if (this.db.prepare('SELECT 1 FROM runs WHERE id=?').get(id)) continue;", ''],
  ['worker duplicate delivery', 'if (run.delivered) return false;', ''],
  ['worker independent kill', 'readFileSync(store.killFile); return true;', 'readFileSync(store.killFile); return false;'],
  ['worker kill read failure', "if (error.code !== 'ENOENT') return true;", "if (error.code !== 'ENOENT') return false;"],
  ['worker kill database latch', "return store.db.prepare('SELECT killed FROM worker_control WHERE id=1').get().killed === 1;",
    'return false;'],
  ['worker token binding',
    'event.approval !== run.approval || event.spec_hash !== run.spec_hash', 'false'],
  ['worker stop receipt', "if (outcome.effects.some(effect => effect.kind === 'build.stop'))", 'if (false)'],
  ['worker stop retry', "if (!terminal(observed.state)) return;", 'if (false) return;'],
  ['worker stopped token', "run.status === 'stopped' || (event.type !== 'failed' && run.status !== 'active')", 'false'],
  ['worker store kill gate', "if (['tried', 'charged'].includes(event.type) && killed(store))", 'if (false)'],
  ['watchdog stale heartbeat', 'now - heartbeat.at > heartbeatMs', 'false'],
  ['watchdog unrecoverable outbox', "state IN ('dead','sending')", "state IN ('delivered')"],
  ['watchdog emergency stop', 'setKill(store, true);', 'setKill(store, false);'],
  ['portable Quest schema binding', 'JSON.stringify(value.memo) !== JSON.stringify(expected)', 'false'],
  ['portable Quest explicit approval', "if (approved !== true) throw Error('explicit approval required');", 'if (false)'],
  ['fake idempotent start', 'INSERT OR IGNORE INTO fake_jobs VALUES(?,?,?,?)', 'INSERT INTO fake_jobs VALUES(?,?,?,?)'],
  ['fake identity binding', 'if (prior && prior.input !== input)', 'if (false)'],
  ['fake stop observed', "DO UPDATE SET status='stopped'", "DO UPDATE SET status='ready'"],
  ['container repeated start resumes', "if (row.state === 'running') return;", ''],
  ['container network isolation', "'--network', 'none'", "'--network', 'bridge'"],
  ['container read only root', "'--read-only'", "'--read-write'"],
  ['container drops capabilities', "'--cap-drop', 'ALL'", "'--cap-add', 'ALL'"],
  ['container no new privileges', "'no-new-privileges=true'", "'no-new-privileges=false'"],
  ['container pid limit', "'--pids-limit', '32'", "'--pids-limit', '32000'"],
  ['container memory limit', "'--memory', '64m'", "'--memory', '640m'"],
  ['container cpu limit', "'--cpus', '0.50'", "'--cpus', '50'"],
  ['container gateway model binding', "'--env', `SSS_GATEWAY_MODEL=${this.gatewayModel}`", "'--env', 'SSS_GATEWAY_MODEL=unreviewed'"],
  ['builder markdown extraction', 'return match ? match[0] : text.trim()', 'return text.trim()'],
  ['container wall clock limit', 'expired(row) { return this.now() >= row.deadline; }', 'expired(row) { return false; }'],
  ['CSRF token check', "req.headers['x-csrf-token'] !== session?.csrf", 'false'],
  ['Origin check', 'new URL(value).origin === new URL(expected).origin', 'true'],
  ['Origin prefix match', 'new URL(value).origin === new URL(expected).origin', 'String(value).startsWith(expected)'],
  ['SameSite attribute', 'SameSite=Strict', 'SameSite=Lax'],
  ['HttpOnly cookie', '; HttpOnly', ''],
  ['rate limit', 'return this.take(`${action}:ip:${ip}`) && this.take(`${action}:account:${account}`);', 'return true;'],
  ['address lockout backoff', 'Math.min(failureWindow, 1000 * 2 ** pair.n)', '0'],
  ['lockout is per address', 'WHERE account=? AND ip=?', 'WHERE account=? AND (ip=? OR 1=1)'],
  ['account failure ceiling', 'return account.n >= accountFailureCeiling;', 'return false;'],
  ['bucket pruning', 'if (this.buckets.size > 10_000) this.prune();', ''],
  ['bucket hard cap', 'while (this.buckets.size > 50_000)', 'while (false)'],
  ['secure first password', 'randomBytes(18).toString(\'base64url\')', 'Math.random().toString(36).slice(2)'],
  ['database file mode', 'chmodSync(file, 0o600);', 'chmodSync(file, 0o644);'],
  ['backup file mode', 'chmodSync(target, 0o600);', 'chmodSync(target, 0o644);'],
  ['verify submission hash', 'submittedEventHash(this.submittedEventFromRow(row), row.idem) !== row.submitted_hash', 'false'],
  ['verify idempotency key', 'digest(stable({ idem, event }))', 'digest(stable({ event }))'],
  ['verify orphaned events', "...this.db.prepare('SELECT DISTINCT item FROM events').all().map(row => row.item),", ''],
  ['verify cache drift', "return same ? { item, ok: true } : { item, ok: false, reason: 'cache' };", 'return { item, ok: true };'],
  ['user enumeration', "throw new Error('login unavailable');", "throw new Error('unknown user');"],
  ['step-up freshness', 'row.stepup + 5 * minute < this.clock()', 'false'],
  ['step-up single use', 'AND stepup_used=0', 'AND 1=1'],
  ['invite single use', "UPDATE invites SET used=1 WHERE digest=? AND used=0", "UPDATE invites SET used=1 WHERE digest=?"],
  ['plaintext token storage', 'insert.run(hash(value), kind, item)', 'insert.run(value, kind, item)'],
  ['client-supplied role accepted', "Object.hasOwn(input, 'actor') || Object.hasOwn(input, 'role')", 'false'],
  ['session idle expiry', 'row.seen + 30 * minute <= this.clock()', 'false'],
  ['session rotation on login', 'this.revokePerson(id);', ''],
  ['core role rejection', "if (Object.hasOwn(event, 'role'))", 'if (false)'],
  ['core approval binding', "function currentApproval(state, event) {\n  if (event.approval !== state.approval) return fail('approval does not match current approval');\n  if (event.spec_hash !== state.specHash) return fail('spec hash does not match approved spec');\n  return null;\n}", 'function currentApproval() { return null; }'],
  ['output escaping', '/[&<>"\']/g,', '/NEVER_MATCHES/g,'],
  ['artifact sandbox header', '"sandbox allow-scripts; default-src \'none\'; style-src', '"default-src \'none\'; style-src'],
  ['viewer opaque origin', 'sandbox=\"allow-scripts\"', 'sandbox=\"allow-scripts allow-same-origin\"'],
  ['member deliver', 'if (!(leader || state.context.steward === session.person))', 'if (false)'],
  ['artifact size limit', "Buffer.byteLength(html, 'utf8') > 256 * 1024", 'false'],
  ['HTML CSP', "'content-security-policy': htmlHeaders", "'content-security-policy': \"default-src *\""],
  ['helper count privacy', 'quorum: context.quorum, helpers: context.helpers.length };', 'quorum: context.quorum, helpers: context.helpers.length, helper_names: context.helpers };'],
  ['history shows token hash', 'event.delivered_by || event.actor', 'event.actor'],
  ['approver and steward can vote', 'const canVote = !context.ineligibleHelpers.includes(person);', 'const canVote = true;'],
  ['artifact stored before stage check', "if (state.state !== 'SENDING') throw new Error('event not allowed');", ''],
  ['checked problem requirement', '&& nonempty(event.problem) && event.problem.length <= 2000', ''],
  ['insider exclusion', '&& !context.ineligibleHelpers.includes(event.actor)', '&& true'],
  ['legacy authority captured once', 'AND (actor_kind IS NULL OR actor_leader IS NULL)', ''],
  ['legacy cache migration', '      this.rebuild();', ''],
  ['authority snapshot replay', 'return { kind: row.actor_kind, leader: row.actor_leader === 1 };', "return { kind: 'person', leader: false };"],
  ['redaction receipt binding', 'erased.get(row.body_hash) !== scopedBodyHash(item, body.bytes)', 'false'],
  ['redaction unknown fields', 'const tombstone = {};', 'const tombstone = { ...body };'],
  ['erase redaction', "this.db.prepare('UPDATE bodies SET bytes=?, erased=1 WHERE hash=?').run(tombstone, targetHash);", "this.db.prepare('DELETE FROM bodies WHERE hash=?').run(targetHash);"],
  ['transaction before await', "// Password work must finish before the transaction so other requests stay isolated.\n    const record = await this.passwordRecord(password);\n    this.db.exec('BEGIN IMMEDIATE');", "this.db.exec('BEGIN IMMEDIATE');\n    const record = await this.passwordRecord(password);"],
  ['usdToMicros tolerance', 'if (Math.abs(scaled - micros) > tolerance) return null;', 'if (Math.abs(scaled - micros) > 0) return null;'],
  ['export actors registry', "const actors = this.db.prepare('SELECT id,kind,leader,item FROM actors ORDER BY id').all();", 'const actors = [];'],
  ['quest server rederivation',
    'input.quest ? checkedFromQuest(input.quest, session.person) : checked(input);',
    'input.quest ? { ...checked(input), quest: input.quest } : checked(input);'],
  ['quest refused on the event route', "if (Object.hasOwn(input, 'quest')) return json(res, 409, { error: 'request refused' });", ''],
  ['quest names its signed-in person', 'doc.person !== person ||', 'false ||'],
  ['quest field length bound', "typeof value === 'string' && value.length <= 2000 &&", "typeof value === 'string' &&"],
  ['quest turn count bound', 'doc.turns.length > 120 ||', 'false ||'],
  ['quest byte bound', 'byteLength > 120000', 'byteLength > 1e12'],
  ['quest unknown keys refused', 'Object.keys(value).every(key => keys.includes(key))', 'true'],
  ['quest playback gate', "if (position > 10 && playbackAt < 0) throw Error('Confirm the playback first.');", ''],
  ['quest safety stop covers history', '.some(turn => safety.test(screenText(`${turn.value} ${turn.note}`)));', '.some(() => false);'],
  ['quest process change verdict',
    "recommendation === 'CONFIGURE' || recommendation === 'PROCESS CHANGE' ? 'setting' :",
    "recommendation === 'CONFIGURE' ? 'setting' :"],
  ['quest kill is never posted', "draft.stopped || draft.recommendation === 'KILL' ||", 'draft.stopped ||'],
  ['quest squirrel weights', '{ impact: 40, repeat: 30, control: 20, evidence: 10 }',
    '{ impact: 25, repeat: 25, control: 25, evidence: 25 }'],
  ['quest squirrel threshold', 'SQUIRREL_THRESHOLD = 60;', 'SQUIRREL_THRESHOLD = 0;'],
  ['quest draft is keyed by person', 'const keyFor = person => `sss-quest:${encodeURIComponent(person)}`;',
    "const keyFor = () => 'sss-quest:shared';"],
  ['quest restore checks the person', 'validateQuest(envelope.data, person);', 'validateQuest(envelope.data);'],
  ['quest spec draft is escaped', "escape(draftSpec[key].join('\\n'))", "String(draftSpec[key].join('\\n'))"],
  ['quest memo is escaped', 'Decision owner: ${escape(questDraft.memo.decisionOwner)}', 'Decision owner: ${questDraft.memo.decisionOwner}'],
  ['quest page makes no outside request', "await fetch('/api/me')", "await fetch('https://example.invalid/api/me')"],
  ['comment version anchor', "if (event.anchor_kind === 'artifact') return event.anchor_hash === state.artifact;", 'return true;'],
  ['reported evidence actor binding', 'evidence.reported_by !== actor', 'false'],
  ['builder egress policy', "policy.egress.length !== 0", 'false'],
  ['builder emergency kill', 'emergencyKill(`builder policy violation: ${attempt.kind}`);', ''],
  ['oidc state single use', 'this.pending.delete(state);', ''],
  ['oidc browser binding', 'pending.binderHash !== sha256(binder)', 'false'],
  ['oidc state expiry', 'pending.expires <= this.clock()', 'false'],
  ['oidc issuer check', 'claims.iss !== this.issuer', 'false'],
  ['oidc pending cap', "if (this.pending.size >= maxPending) throw new Error('too many pending OIDC handshakes');", ''],
  ['account id bound on create', "async createUser(id, password, leader = false) {\n    if (!validAccountId(id)) throw new Error('invalid account id');", "async createUser(id, password, leader = false) {"],
  ['account id bound on redeem', "async redeem(value, id, password, ip = 'local') {\n    if (!validAccountId(id)) throw new Error('invalid account id');", "async redeem(value, id, password, ip = 'local') {"],
  ['oidc audience check', '!audience.includes(this.clientId)', 'false'],
  ['oidc nonce check', 'claims.nonce !== nonce', 'false'],
  ['oidc token expiry', 'claims.exp <= now', 'false'],
  ['draft explicit approval', "if (approved !== true) throw Error('explicit approval required');", ''],
  ['provider command env isolation', "env: { PATH: process.env.PATH || '/usr/bin:/bin' }", 'env: process.env'],
  ['provider priced required', "if (!provider.price || !integer(provider.price.inputMicrosPerMillion) || !integer(provider.price.outputMicrosPerMillion)) throw Error('priced provider required');", ''],
  ['provider host allowlist', "if (!Array.isArray(hosts) || !hosts.includes(url.hostname)) throw Error('provider host is not allowlisted');", ''],
  ['provider redirect refusal', "redirect: 'error'", "redirect: 'follow'"],
  ['provider response cap', "if (bytes > responseBytes)", "if (false)"],
  ['approval leader gate', "if (event.type === 'approved' && context.phase === 'SPECCED' && leader(who)",
    "if (event.type === 'approved' && context.phase === 'SPECCED' && true"],
  ['approval separation gate', '&& event.actor !== context.steward && nonempty(event.spec_hash)',
    '&& true && nonempty(event.spec_hash)'],
  ['builder egress enforcement', "if (!denied) return { allowed: true };", "if (true) return { allowed: true };"],
  ['comment artifact anchor binding', "if (event.anchor_kind === 'artifact') return event.anchor_hash === state.artifact;",
    "if (event.anchor_kind === 'artifact') return true;"],
  ['OIDC redirect URI validation', "this.redirectUri = validUrl(config.redirectUri, 'redirect URI');",
    'this.redirectUri = config.redirectUri;'],
  ['integration signature', "!equal(signature(row.secret, timestamp, bytes), String(supplied || '').replace(/^sha256=/, ''))", 'false'],
  ['integration timestamp window', 'Math.abs(this.clock() - time) > WINDOW', 'false'],
  ['integration replay protection', "if (accepted.changes !== 1) throw Error('inbound refused');", 'if (false) throw Error(\'inbound refused\');'],
  ['integration strict schema', "!Object.keys(value).every(key => ['problem', 'source_label', 'honesty_label'].includes(key))", 'false'],
  ['integration source authority', "event.type === 'seen' && context.phase === 'SEEN' && sourceActor(who)", "event.type === 'seen' && context.phase === 'SEEN' && person(who)"],
  ['integration outbox transaction', 'this.enqueueIntegrationOutbox(item, event, outcome.state, seq);', ''],
  ['integration outbound redirect refusal', "redirect: 'error'", "redirect: 'follow'"],
];

function run(cwd, args) {
  return spawnSync(process.execPath, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

const onlyAt = process.argv.indexOf('--only');
const only = onlyAt < 0 ? null : process.argv[onlyAt + 1];
if (onlyAt >= 0 && !only) throw new Error('--only requires a mutant name');
const selected = mutants.filter(([name]) => (!only || name.includes(only)) &&
  (!workerOnly || name.startsWith('worker ') || name.startsWith('fake ') || name.startsWith('container ')));
if (!selected.length) throw new Error('no mutant matches the requested name');

const baseline = run(root, [...suite, 'test/check-public.test.mjs']);
if (baseline.status !== 0 || /# skipped [^0]/.test(baseline.stdout)) {
  console.error('Baseline suite is not fully green with zero skipped tests.');
  process.stderr.write(baseline.stdout + baseline.stderr);
  process.exit(1);
}

let failed = false;
for (const [name, find, replace] of selected) {
  const copy = mkdtempSync(join(tmpdir(), 'sss-mutant-'));
  cpSync(root, copy, { recursive: true, filter: path => !path.includes('/.git') && !path.includes('/node_modules') });
  const files = ['app/auth.js', 'app/http.js', 'app/pages.js', 'core/machine.js', 'core/store.js', 'cli.js',
    'public/vision-quest.js', 'public/quest-storage.js', 'public/quest-ui.js',
    'worker/control.js', 'worker/watchdog.js', 'worker/policy.js', 'worker/container.js', 'drafting/preflight.js', 'app/oidc.js', 'app/integrations.js', 'worker/runner.js', 'worker/fake.js', 'gateway/ledger.js', 'gateway/http.js', 'provider/config.js', 'provider/safe-http.js', 'provider/adapters.js', 'provider/vision-quest.js'];
  let changed = false;
  let changedFile = '';
  for (const file of files) {
    const path = join(copy, file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(find)) continue;
    writeFileSync(path, source.replace(find, replace));
    changed = true;
    changedFile = file;
    break;
  }
  if (!changed) throw new Error(`mutant source missing: ${name}`);
  const result = run(copy, suite);
  const killed = result.status !== 0;
  console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${name}`);
  failed ||= !killed;
  rmSync(copy, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
