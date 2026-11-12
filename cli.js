import { chmodSync, constants, copyFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Store } from './core/store.js';
import { Worker } from './worker/runner.js';
import { killed, setKill } from './worker/control.js';
import { watchdog } from './worker/watchdog.js';
import { Ledger, fixturePolicy } from './gateway/ledger.js';
import { Gateway, createGatewayServer, providerGateway } from './gateway/http.js';
import { QuestGateway } from './gateway/quest.js';
import { fixtureProvider } from './gateway/fixture.js';
import { readFileSync } from 'node:fs';
import { readProviders, saveProviders, validateProvider, providerFor, meteredProviderFor } from './provider/config.js';
import { redact } from './provider/safe-http.js';
import { SYSTEM_PROMPT } from './worker/builder/index.js';
import { Auth } from './app/auth.js';
import { createServerFor } from './app/http.js';
import { Integrations } from './app/integrations.js';
import { questModelService } from './provider/quest-service.js';
import { validateCompletion } from './provider/index.js';

const fail = message => {
  throw new Error(message);
};

export async function main(argv = process.argv.slice(2), env = process.env, write = console.log) {
  const [command, ...args] = argv;
  const value = flag => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const file = env.SSS_DB || 'sss.db';
  // Restore must run before opening SQLite. Opening a missing target would create it.
  if (command === 'restore') {
    const source = value('--from') || fail('missing --from');
    if (!existsSync(source)) fail('backup missing');
    if (existsSync(file)) fail('restore target already exists');
    copyFileSync(source, file, constants.COPYFILE_EXCL);
    chmodSync(file, 0o600);
    write('restored');
    return;
  }
  const store = new Store(file);
  const auth = new Auth(store);
  const integrations = new Integrations(store);
  if (command === 'integration') {
    const kind = args[0]; const action = args[1];
    if (kind === 'source' && action === 'add') {
      integrations.addSource(value('--name') || fail('missing --name'), value('--secret') || fail('missing --secret'), Number(value('--rate-limit') || '30'));
      write(`integration source ${value('--name')} added`);
    } else if (kind === 'source' && action === 'list') {
      for (const row of integrations.list('source')) write(JSON.stringify(row));
    } else if (kind === 'destination' && action === 'add') {
      integrations.addDestination(value('--name') || fail('missing --name'), value('--url') || fail('missing --url'), value('--secret') || fail('missing --secret'), { includeText: args.includes('--include-text'), allowLoopback: args.includes('--allow-loopback') });
      write(`integration destination ${value('--name')} added`);
    } else if (kind === 'destination' && action === 'list') {
      for (const row of integrations.list('destination')) write(JSON.stringify(row));
    } else if (kind === 'outbox' && action === 'list') {
      for (const row of integrations.outbox()) write(JSON.stringify(row));
    } else if (kind === 'outbox' && action === 'deliver') {
      let delivered = 0; while (await integrations.deliverOnce()) delivered += 1;
      write(`outbox attempts: ${delivered}`);
    } else fail('expected integration source, destination, or outbox command');
  } else if (command === 'provider') {
    const subcommand = args[0];
    if (subcommand === 'list') {
      const data = readProviders(env);
      for (const provider of data.providers) write(JSON.stringify({ ...provider, apiKey: undefined }));
      write(JSON.stringify({ defaults: data.defaults }));
    } else if (subcommand === 'add') {
      const source = value('--file') || fail('missing --file');
      const candidate = JSON.parse(readFileSync(source, 'utf8'));
      validateProvider(candidate);
      if (Object.hasOwn(candidate, 'apiKey')) fail('credentials belong in an environment variable or file, never config');
      const data = readProviders(env);
      if (data.providers.some(provider => provider.name === candidate.name)) fail('provider already exists');
      data.providers.push(candidate);
      const org = value('--default-org');
      if (org) data.defaults[org] = candidate.name;
      saveProviders(data, env); write(`provider ${candidate.name} added${org ? ` and set as ${org} default` : ''}`);
    } else if (subcommand === 'default') {
      const org = value('--org') || fail('missing --org'); const name = value('--name') || fail('missing --name');
      const data = readProviders(env); const entry = data.providers.find(provider => provider.name === name && provider.enabled);
      if (!entry) fail('provider is not enabled'); data.defaults[org] = name; saveProviders(data, env);
      write(`provider ${name} set as ${org} default`);
    } else if (subcommand === 'remove' || subcommand === 'disable') {
      const name = value('--name') || fail('missing --name'); const data = readProviders(env);
      const index = data.providers.findIndex(provider => provider.name === name);
      if (index < 0) fail('unknown provider');
      if (subcommand === 'remove') data.providers.splice(index, 1);
      else data.providers[index] = { ...data.providers[index], enabled: false };
      for (const [org, selected] of Object.entries(data.defaults)) if (selected === name) delete data.defaults[org];
      saveProviders(data, env); write(`provider ${name} ${subcommand}d`);
    } else if (subcommand === 'test') {
      const name = value('--name') || fail('missing --name'); const config = readProviders(env);
      const entry = config.providers.find(provider => provider.name === name && provider.enabled);
      if (!entry) fail('provider is not enabled');
      const maxOutputTokens = Number(value('--max-output') || '1');
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16) fail('test max output must be 1 through 16');
      const worst = Math.ceil((entry.price.inputMicrosPerMillion + entry.price.outputMicrosPerMillion * maxOutputTokens) / 1_000_000);
      write(`One test call will reserve at most ${worst} micro-dollars. Continuing.`);
      const result = await providerFor(name, env).complete({ system: 'Reply with OK.', messages: [{ role: 'user', content: 'OK' }], maxOutputTokens, model: entry.model, signal: AbortSignal.timeout(entry.timeoutMs || 10_000) });
      write(JSON.stringify({ provider: name, usage: result.usage, text: redact(result.text) }));
    } else fail('expected provider add, list, test, default, remove, or disable');
  } else if (command === 'gateway') {
    const ledger = new Ledger(store);
    if (args[0] === 'fixture-enable') {
      ledger.configure(fixturePolicy());
      write('Local fixture enabled. No real provider is configured.');
    } else if (args[0] === 'policy' && args[1] === 'set') {
      const source = value('--file') || fail('missing --file');
      const version = ledger.setPolicy(JSON.parse(readFileSync(source, 'utf8')));
      write(`gateway policy version ${version} set`);
    } else if (args[0] === 'mint') {
      write(ledger.mint(value('--run') || fail('missing --run')));
    } else if (args[0] === 'revoke') {
      ledger.revokeDigest(value('--digest') || fail('missing --digest'));
    } else if (['status', 'verify'].includes(args[0])) {
      write(JSON.stringify(ledger.summary(value('--item'))));
    } else if (args[0] === 'holds' && args[1] === 'list') {
      for (const row of ledger.holds()) write(JSON.stringify(row));
    } else if (args[0] === 'holds' && args[1] === 'release') {
      const row = ledger.releaseHold(value('--id') || fail('missing --id'), { actor: value('--actor') || 'cli',
        reason: value('--reason') || fail('missing --reason'), refund: args.includes('--refund') });
      write(JSON.stringify({ id: row.id, state: row.state, charged_micros: row.charged_micros }));
    } else if (args[0] === 'serve-fixture') {
      const server = createGatewayServer(new Gateway(ledger, fixtureProvider));
      const port = Number(value('--port') || '8081');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      write(`Fixture gateway http://127.0.0.1:${server.address().port}; no real provider`);
      return;
    } else if (args[0] === 'serve-provider') {
      const name = value('--name') || readProviders(env).defaults[value('--org') || 'default'] || fail('missing --name or configured --org default');
      const selected = meteredProviderFor(name, env);
      const providerLedger = new Ledger(store, { rate: selected.rate });
      if (!providerLedger.policy().enabled) fail('gateway is disabled');
      const server = createGatewayServer(providerGateway(providerLedger, selected.provider, { system: SYSTEM_PROMPT }));
      const port = Number(value('--port') || '8081');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      const worst = Math.ceil((selected.rate.input_micros_per_million * 8192 + selected.rate.output_micros_per_million * providerLedger.policy().output_tokens) / 1_000_000);
      write(`Metered provider gateway http://127.0.0.1:${server.address().port}; provider=${name}; model=${selected.rate.model}; worst-case=${worst} micro-dollars before approval`);
      return;
    } else fail('expected gateway fixture-enable, policy set, mint, revoke, status, verify, holds list, holds release, serve-fixture, or serve-provider');
  } else if (command === 'kill') {
    if (!['set', 'clear', 'status'].includes(args[0])) fail('expected kill set, clear, or status');
    if (args[0] !== 'status') setKill(store, args[0] === 'set');
    write(killed(store) ? 'stopped' : 'clear');
  } else if (command === 'worker') {
    const worker = new Worker(store);
    do {
      worker.reconcile();
      if (!args.includes('--once')) await new Promise(resolve => setTimeout(resolve, 250));
    } while (!args.includes('--once'));
  } else if (command === 'watchdog') {
    const result = watchdog(store, { heartbeatMs: Number(value('--heartbeat-ms') || 15000), runMs: Number(value('--run-ms') || 900000), outboxMs: Number(value('--outbox-ms') || 900000) });
    write(JSON.stringify(result));
  } else if (command === 'init') {
    if (auth.db.prepare('SELECT 1 FROM users LIMIT 1').get()) fail('already initialized');
    const password = `Start-${randomBytes(18).toString('base64url')}-9a`;
    await auth.createUser(value('--id') || 'leader', password, true, { mustChange: true });
    write(`one-time password: ${password}`);
  } else if (command === 'invite' && args[0] === 'create') {
    const role = value('--role');
    const hours = Number((value('--expires') || '24h').replace('h', ''));
    write(auth.createInvite(role, Date.now() + hours * 60 * 60 * 1000));
  } else if (command === 'invite' && args[0] === 'list') {
    for (const row of auth.listInvites()) write(JSON.stringify(row));
  } else if (command === 'invite' && args[0] === 'revoke') {
    const row = auth.revokeInvite(value('--id') || fail('missing --id'));
    write(`invite ${row.id} revoked`);
  } else if (command === 'person') {
    const action = args[0];
    const who = () => value('--id') || fail('missing --id');
    if (action === 'list') {
      for (const row of auth.listPeople()) write(JSON.stringify(row));
    } else if (action === 'disable') {
      auth.disablePerson(who()); write('person disabled; their sessions ended');
    } else if (action === 'enable') {
      auth.enablePerson(who()); write('person enabled');
    } else if (action === 'promote') {
      auth.setLeader(who(), true); write('person promoted to leader');
    } else if (action === 'demote') {
      auth.setLeader(who(), false); write('person demoted from leader');
    } else if (action === 'reset') {
      const code = await auth.resetPerson(who());
      write(`single-use code: ${code}`);
    } else fail('expected person list, disable, enable, promote, demote, or reset');
  } else if (command === 'session' && args[0] === 'revoke') {
    auth.revokePerson(value('--person') || fail('missing --person'));
  } else if (command === 'token' && args[0] === 'create') {
    write(auth.createToken(value('--kind'), value('--item')));
  } else if (command === 'verify') {
    let bad = false;
    for (const answer of store.verifyAll()) {
      write(`${answer.item}: ${answer.ok ? 'ok' : answer.reason}`);
      bad ||= !answer.ok;
    }
    if (bad) process.exitCode = 1;
  } else if (command === 'export') {
    write(store.exportJsonl());
  } else if (command === 'backup') {
    const target = value('--to') || fail('missing --to');
    if (!existsSync(file)) fail('database missing');
    if (existsSync(target)) fail('backup target exists');
    auth.db.exec('PRAGMA wal_checkpoint(FULL)');
    copyFileSync(file, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
  } else if (command === 'serve') {
    const port = Number(value('--port') || '8080');
    const origin = value('--origin') || `http://127.0.0.1:${port}`;
    const insecure = args.includes('--insecure-cookies');
    // Loopback by default. A container needs --host 0.0.0.0 so its published port reaches the server.
    const host = value('--host') || '127.0.0.1';
    if (!/^[0-9a-fA-F:.]+$/.test(host)) fail('--host must be an IP address');
    let questModel = null;
    if (args.includes('--enable-quest-model')) {
      const name = value('--quest-provider') || readProviders(env).defaults.default || fail('missing --quest-provider or configured default');
      const selected = meteredProviderFor(name, env); const ledger = new Ledger(store, { rate: selected.rate });
      if (!ledger.policy().enabled) fail('gateway is disabled');
      const gateway = new QuestGateway(ledger, async input => {
        const result = validateCompletion(await selected.provider.complete({ system: 'Draft only. Never decide or claim verification. Return JSON only.',
          messages: [{ role: 'user', content: input.input }], maxOutputTokens: input.max_output_tokens, model: input.model,
          signal: AbortSignal.timeout(ledger.policy().timeout_ms) }));
        return { output: result.text, usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens } };
      });
      questModel = questModelService(gateway, name, env);
    }
    const server = createServerFor({ store, auth, integrations, questModel, secure: !insecure, origin });
    await new Promise(resolve => server.listen(port, host, resolve));
    write(`Serving ${origin}`);
    if (insecure) write('WARNING: insecure cookies are enabled for local HTTP development only.');
    return;
  } else fail('unknown command');
  store.close();
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
