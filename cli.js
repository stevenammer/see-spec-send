import { chmodSync, constants, copyFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Store } from './core/store.js';
import { Worker } from './worker/runner.js';
import { killed, setKill } from './worker/control.js';
import { Ledger, fixturePolicy } from './gateway/ledger.js';
import { Gateway, createGatewayServer, providerGateway } from './gateway/http.js';
import { fixtureProvider } from './gateway/fixture.js';
import { readFileSync } from 'node:fs';
import { readProviders, saveProviders, validateProvider, providerFor, meteredProviderFor } from './provider/config.js';
import { redact } from './provider/safe-http.js';
import { SYSTEM_PROMPT } from './worker/builder/index.js';
import { Auth } from './app/auth.js';
import { createServerFor } from './app/http.js';

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
  const store = new Store(file);
  const auth = new Auth(store);
  if (command === 'provider') {
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
    } else if (args[0] === 'mint') {
      write(ledger.mint(value('--run') || fail('missing --run')));
    } else if (args[0] === 'revoke') {
      ledger.revokeDigest(value('--digest') || fail('missing --digest'));
    } else if (['status', 'verify'].includes(args[0])) {
      write(JSON.stringify(ledger.summary(value('--item'))));
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
    } else fail('expected gateway fixture-enable, mint, revoke, status, verify, serve-fixture, or serve-provider');
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
  } else if (command === 'init') {
    if (auth.db.prepare('SELECT 1 FROM users LIMIT 1').get()) fail('already initialized');
    const password = `Start-${randomBytes(18).toString('base64url')}-9a`;
    await auth.createUser(value('--id') || 'leader', password, true);
    write(`one-time password: ${password}`);
  } else if (command === 'invite' && args[0] === 'create') {
    const role = value('--role');
    const hours = Number((value('--expires') || '24h').replace('h', ''));
    write(auth.createInvite(role, Date.now() + hours * 60 * 60 * 1000));
  } else if (command === 'person' && args[0] === 'list') {
    for (const row of auth.db.prepare('SELECT id,leader FROM users ORDER BY id').all())
      write(JSON.stringify(row));
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
    const server = createServerFor({ store, auth, secure: !insecure, origin });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
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
