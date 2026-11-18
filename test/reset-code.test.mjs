import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';

test('a reset code is long, random and different every time', async t => {
  const store = new Store(); t.after(() => store.close()); const auth = new Auth(store);
  await auth.createUser('nick', 'fixture-password-123', false);
  const first = await auth.resetPerson('nick'), second = await auth.resetPerson('nick');
  for (const code of [first, second]) assert.match(code, /^Reset-[A-Za-z0-9_-]{24}-9a$/, '18 random bytes, not a short guessable string');
  assert.notEqual(first, second);
});
