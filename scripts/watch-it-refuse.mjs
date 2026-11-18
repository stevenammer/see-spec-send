// Starts the real HTTP server on a local port with a throwaway in-memory database,
// plays one item through the Helps rule with invented people, and prints each request
// with its status code and the item's state afterward. docs/WATCH_IT_REFUSE.md holds
// this output, and test/watch-it-refuse.test.mjs fails if either one drifts.
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { createServerFor } from '../app/http.js';

const password = 'correct-horse-9-battery';

export async function run() {
  const store = new Store();
  const auth = new Auth(store);
  for (const [id, leader] of [['jose', true], ['nick', false], ['steven', false], ['cleo', false]])
    await auth.createUser(id, password, leader);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = createServerFor({ store, auth, secure: false, origin: base });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const lines = [];
  const codes = {};
  try {
    const sessions = {};
    for (const id of ['jose', 'nick', 'steven', 'cleo']) {
      const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, password }),
      });
      sessions[id] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: (await login.json()).csrf };
    }
    let item;
    const send = async (who, label, path, input, key) => {
      // A post is frozen once it moves on, so each request names the post it is about, the way the page does.
      const active = item ? store.read(item).context.activePost : null;
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: sessions[who].cookie,
          origin: base,
          'x-csrf-token': sessions[who].csrf,
          ...(active ? { 'x-post-id': active.id, 'x-post-version': active.version } : {}),
        },
        body: JSON.stringify(input),
      });
      const body = await response.json().catch(() => ({}));
      if (body.id) item = body.id;
      const state = item ? store.read(item) : null;
      const progress = state?.state === 'TRYING' && state.context?.quorum
        ? ` (${state.context.helpers?.length ?? 0} of ${state.context.quorum} helpers)` : '';
      const outcome = response.status < 300 ? 'accepted' : 'refused';
      lines.push(`${who.padEnd(6)} ${label.padEnd(44)} ${response.status} ${outcome.padEnd(8)} item is ${state?.state}${progress}`);
      if (key) codes[key] = response.status;
      return state;
    };
    const events = '/api/items/ITEM/events';
    const at = path => path.replace('ITEM', item);

    await send('nick', 'post a problem', '/api/items', { original: 'We copy every refund into a spreadsheet by hand.' });
    const see = store.read(item).context.seeHash;
    await send('steven', 'add what they know in a comment', at(events), {
      type: 'commented', kind: 'concern', comment: 'It gets worse when two of us edit the sheet at the same time.', anchor_kind: 'see', anchor_hash: see,
    });
    await send('nick', 'write the spec', at(events), {
      type: 'specced', see_hash: see, must: ['Show each refund once'], how_we_know: ['Nobody opens the spreadsheet'], out_of_scope: [],
    });
    const specHash = store.read(item).context.specHash;
    await send('nick', 'send it for a decision', at('/api/items/ITEM/send'), { spec_hash: specHash });
    await fetch(`${base}/api/stepup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessions.jose.cookie, origin: base, 'x-csrf-token': sessions.jose.csrf },
      body: JSON.stringify({ password }),
    });
    await send('jose', 'approve, cap $5, quorum 2', at(events), {
      type: 'approved', spec_hash: specHash, packet_hash: store.read(item).context.sent.packetHash,
      reason: 'Small enough to try, and the spec is clear.', cap_usd: 5, quorum: 2,
    });
    const state = await send('nick', 'deliver one playable try', at('/api/items/ITEM/artifact'), { html: '<h1>Refunds</h1>' });
    const artifact = state.context.artifact;
    const help = { type: 'helped', artifact_hash: artifact };
    lines.push('');
    await send('nick', 'say it helps (they wrote the spec)', at(events), help, 'author');
    await send('jose', 'say it helps (they approved it)', at(events), help, 'approver');
    await send('nick', 'make up a "done" event', at(events), { type: 'done' }, 'done');
    await send('steven', 'say it helps', at(events), help, 'first');
    const last = await send('cleo', 'say it helps', at(events), help, 'second');
    codes.final = last.state;
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
  return { text: lines.join('\n'), codes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log((await run()).text);
