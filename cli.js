import { copyFileSync, existsSync } from 'node:fs';
import { Store } from './core/store.js';
import { Auth } from './app/auth.js';

const fail = message => { throw new Error(message); };

export async function main(argv = process.argv.slice(2), env = process.env, write = console.log) {
  const [command, ...args] = argv;
  const value = flag => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const file = env.SSS_DB || 'sss.db';
  const store = new Store(file);
  const auth = new Auth(store);
  if (command === 'init') {
    if (auth.db.prepare('SELECT 1 FROM users LIMIT 1').get()) fail('already initialized');
    const password = `Start-${Math.random().toString(36).slice(2)}-9a`;
    await auth.createUser(value('--id') || 'leader', password, true);
    write(`one-time password: ${password}`);
  } else if (command === 'invite' && args[0] === 'create') {
    const role = value('--role');
    const hours = Number((value('--expires') || '24h').replace('h', ''));
    write(auth.createInvite(role, Date.now() + hours * 60 * 60 * 1000));
  } else if (command === 'person' && args[0] === 'list') {
    for (const row of auth.db.prepare('SELECT id,leader FROM users ORDER BY id').all()) write(JSON.stringify(row));
  } else if (command === 'session' && args[0] === 'revoke') {
    auth.revokePerson(value('--person') || fail('missing --person'));
  } else if (command === 'token' && args[0] === 'create') {
    write(auth.createToken(value('--kind'), value('--item')));
  } else if (command === 'verify') {
    let bad = false;
    for (const { item } of store.db.prepare('SELECT item FROM items ORDER BY item').all()) {
      const answer = store.verify(item);
      write(`${item}: ${answer.ok ? 'ok' : answer.reason}`);
      bad ||= !answer.ok;
    }
    if (bad) process.exitCode = 1;
  } else if (command === 'export') {
    write(store.exportJsonl());
  } else if (command === 'backup') {
    const target = value('--to') || fail('missing --to');
    if (!existsSync(file)) fail('database missing');
    auth.db.exec('PRAGMA wal_checkpoint(FULL)');
    copyFileSync(file, target);
  } else fail('unknown command');
  store.close();
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
