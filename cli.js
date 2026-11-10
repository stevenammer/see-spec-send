import { chmodSync, constants, copyFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Store } from './core/store.js';
import { Worker } from './worker/runner.js';
import { killed, setKill } from './worker/control.js';
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
  if (command === 'kill') {
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
